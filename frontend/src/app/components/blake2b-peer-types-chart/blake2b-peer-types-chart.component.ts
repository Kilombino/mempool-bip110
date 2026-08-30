import { ChangeDetectionStrategy, ChangeDetectorRef, Component, Input, NgZone, OnInit, HostBinding } from '@angular/core';
import { Observable } from 'rxjs';
import { tap, shareReplay } from 'rxjs/operators';
import { EChartsOption } from '../../graphs/echarts';
import { BitnodesService, Blake2bPeersResponse } from '../../services/bitnodes.service';
import { download } from '../../shared/graphs.utils';
import { isMobile } from '../../shared/common.utils';

@Component({
  selector: 'app-blake2b-peer-types-chart',
  templateUrl: './blake2b-peer-types-chart.component.html',
  styleUrls: ['./blake2b-peer-types-chart.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: false,
})
export class Blake2bPeerTypesChartComponent implements OnInit {
  @Input() height: number = 300;
  @Input() widget = false;

  isLoading = true;
  chartOptions: EChartsOption = {};
  chartInitOptions = { renderer: 'svg' };
  chartInstance: any = undefined;

  @HostBinding('attr.dir') dir = 'ltr';

  peersObservable$: Observable<Blake2bPeersResponse>;

  // Stable colours per network type.
  private readonly netColors: Record<string, string> = {
    onion: '#8E24AA',   // Tor
    ipv4:  '#1E88E5',
    ipv6:  '#00ACC1',
    i2p:   '#43A047',
    cjdns: '#FB8C00',
    unknown: '#6b6b6b',
  };

  constructor(
    private bitnodesService: BitnodesService,
    private cd: ChangeDetectorRef,
    private zone: NgZone,
  ) {}

  ngOnInit(): void {
    this.peersObservable$ = this.bitnodesService.getBlake2bPeersByVersion()
      .pipe(
        tap((data) => {
          this.isLoading = false;
          this.prepareChartOptions(data);
          this.cd.markForCheck();
        }),
        shareReplay(1)
      );
  }

  private niceNet(n: string): string {
    if (n === 'onion') return 'Tor';
    if (n === 'ipv4') return 'IPv4';
    if (n === 'ipv6') return 'IPv6';
    if (n === 'i2p') return 'I2P';
    if (n === 'cjdns') return 'CJDNS';
    return n;
  }

  prepareChartOptions(data: Blake2bPeersResponse): void {
    const total = data.total || 0;
    const pieData = (data.networks || []).map((n) => ({
      value: n.count,
      name: this.niceNet(n.network),
      itemStyle: { color: this.netColors[n.network] || '#9E9E9E' },
      tooltip: {
        formatter: () => {
          const pct = total > 0 ? ((n.count / total) * 100).toFixed(1) : '0.0';
          return `<b style="color: white">${this.niceNet(n.network)}</b><br>${n.count} peers (${pct}%)`;
        }
      }
    }));

    let pieSize = ['20%', '80%'];
    if (this.widget) {
      pieSize = isMobile() ? ['20%', '50%'] : ['15%', '62%'];
    } else if (isMobile()) {
      pieSize = ['15%', '60%'];
    }

    this.chartOptions = {
      animation: true,
      color: Object.values(this.netColors),
      tooltip: {
        trigger: 'item',
        textStyle: { align: 'left' },
        backgroundColor: 'rgba(17, 19, 31, 1)',
      },
      series: [
        {
          zlevel: 0,
          minShowLabelAngle: 1.8,
          name: 'BLAKE2b peer types',
          type: 'pie',
          radius: pieSize,
          data: pieData,
          labelLine: { length2: 25, lineStyle: { width: 2 } },
          label: {
            fontSize: 13,
            color: 'var(--tooltip-grey)',
            formatter: (serie) => `${serie.name}`,
          },
          itemStyle: { borderRadius: 1, borderWidth: 1, borderColor: '#000' },
          emphasis: {
            scale: true,
            scaleSize: 10,
            itemStyle: { shadowBlur: 40, shadowColor: 'rgba(0, 0, 0, 0.75)' },
            labelLine: { lineStyle: { width: 3 } }
          }
        }
      ],
    };
  }

  onChartInit(ec): void {
    if (this.chartInstance !== undefined) { return; }
    this.chartInstance = ec;
  }

  onSaveChart(): void {
    const now = new Date();
    this.chartOptions.backgroundColor = 'var(--active-bg)';
    this.chartInstance.setOption(this.chartOptions);
    download(this.chartInstance.getDataURL({
      pixelRatio: 2,
      excludeComponents: ['dataZoom'],
    }), `blake2b-peer-types-${Math.round(now.getTime() / 1000)}.svg`);
    this.chartOptions.backgroundColor = 'none';
    this.chartInstance.setOption(this.chartOptions);
  }

  getTotal(data: Blake2bPeersResponse): number {
    return data.total || 0;
  }

  getTor(data: Blake2bPeersResponse): number {
    return (data.networks || []).find(n => n.network === 'onion')?.count || 0;
  }

  getClearnet(data: Blake2bPeersResponse): number {
    return (data.networks || []).filter(n => n.network === 'ipv4' || n.network === 'ipv6').reduce((a, n) => a + n.count, 0);
  }
}
