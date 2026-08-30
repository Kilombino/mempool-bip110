import { ChangeDetectionStrategy, Component, Input, NgZone, OnInit, HostBinding } from '@angular/core';
import { Observable } from 'rxjs';
import { tap, shareReplay } from 'rxjs/operators';
import { EChartsOption } from '../../graphs/echarts';
import { BitnodesService, Blake2bPeersResponse } from '../../services/bitnodes.service';
import { download } from '../../shared/graphs.utils';
import { isMobile } from '../../shared/common.utils';

@Component({
  selector: 'app-blake2b-peers-chart',
  templateUrl: './blake2b-peers-chart.component.html',
  styleUrls: ['./blake2b-peers-chart.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: false,
})
export class Blake2bPeersChartComponent implements OnInit {
  @Input() height: number = 300;
  @Input() widget = false;

  isLoading = true;
  chartOptions: EChartsOption = {};
  chartInitOptions = { renderer: 'svg' };
  chartInstance: any = undefined;

  @HostBinding('attr.dir') dir = 'ltr';

  peersObservable$: Observable<Blake2bPeersResponse>;

  // Palette: highlight the current release (rc4) in green, older ones warmer/greyer.
  private readonly palette = [
    '#43A047', '#7CB342', '#1E88E5', '#00ACC1', '#8E24AA',
    '#FB8C00', '#F57C00', '#795548', '#9E9E9E', '#607D8B'
  ];

  constructor(
    private bitnodesService: BitnodesService,
    private zone: NgZone,
  ) {}

  ngOnInit(): void {
    this.peersObservable$ = this.bitnodesService.getBlake2bPeersByVersion()
      .pipe(
        tap(() => {
          this.isLoading = false;
          this.prepareChartOptions();
        }),
        shareReplay(1)
      );
  }

  private colorFor(version: string, index: number): string {
    if (/rc4/i.test(version)) return '#43A047';
    if (/unknown/i.test(version)) return '#6b6b6b';
    return this.palette[index % this.palette.length];
  }

  prepareChartOptions(): void {
    this.peersObservable$.subscribe(data => {
      const total = data.total || 0;
      const pieData = (data.versions || []).map((v, i) => ({
        value: v.count,
        name: v.version,
        itemStyle: { color: this.colorFor(v.version, i) },
        tooltip: {
          formatter: () => {
            const pct = total > 0 ? ((v.count / total) * 100).toFixed(1) : '0.0';
            return `<b style="color: white">${v.version}</b><br>` +
              `${v.count} peers (${pct}%)<br>` +
              `<span style="color:#aaa">${v.inbound} in · ${v.outbound} out</span>`;
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
        color: this.palette,
        tooltip: {
          trigger: 'item',
          textStyle: { align: 'left' },
          backgroundColor: 'rgba(17, 19, 31, 1)',
        },
        series: [
          {
            zlevel: 0,
            minShowLabelAngle: 1.8,
            name: 'BLAKE2b peers',
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
    });
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
    }), `blake2b-peers-by-version-${Math.round(now.getTime() / 1000)}.svg`);
    this.chartOptions.backgroundColor = 'none';
    this.chartInstance.setOption(this.chartOptions);
  }

  getTotal(data: Blake2bPeersResponse): number {
    return data.total || 0;
  }

  getRc4(data: Blake2bPeersResponse): number {
    return (data.versions || []).filter(v => /rc4/i.test(v.version)).reduce((a, v) => a + v.count, 0);
  }

  getVersionCount(data: Blake2bPeersResponse): number {
    return (data.versions || []).length;
  }
}
