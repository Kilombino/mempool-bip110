import { ChangeDetectionStrategy, Component, Input, NgZone, OnInit, OnChanges, SimpleChanges, HostBinding } from '@angular/core';
import { UntypedFormBuilder, UntypedFormGroup } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { EChartsOption, PieSeriesOption } from '@app/graphs/echarts';
import { merge, Observable } from 'rxjs';
import { map, shareReplay, startWith, switchMap, tap } from 'rxjs/operators';
import { SeoService } from '@app/services/seo.service';
import { StorageService } from '@app//services/storage.service';
import { MiningService, MiningStats } from '@app/services/mining.service';
import { StateService } from '@app/services/state.service';
import { originalChartColors as chartColors, poolsColor } from '@app/app.constants';
import { RelativeUrlPipe } from '@app/shared/pipes/relative-url/relative-url.pipe';
import { download } from '@app/shared/graphs.utils';
import { isMobile } from '@app/shared/common.utils';

@Component({
  selector: 'app-pool-ranking',
  templateUrl: './pool-ranking.component.html',
  styleUrls: ['./pool-ranking.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PoolRankingComponent implements OnInit, OnChanges {
  @Input() height: number = 300;
  @Input() widget = false;
  @Input() antPoolProxy = false;

  chartHeight: number = 300; // alto real del chart (adaptativo al nº de pools en la vista grande)

  miningWindowPreference: string;
  radioGroupForm: UntypedFormGroup;

  auditAvailable = false;
  indexingAvailable = false;
  isLoading = true;
  chartOptions: EChartsOption = {};
  chartInitOptions = {
    renderer: 'svg',
  };
  timespan = '';
  chartInstance: any = undefined;
  lastMiningStats: any = null;

  @HostBinding('attr.dir') dir = 'ltr';

  miningStatsObservable$: Observable<MiningStats>;

  constructor(
    public stateService: StateService,
    private storageService: StorageService,
    private formBuilder: UntypedFormBuilder,
    private miningService: MiningService,
    private seoService: SeoService,
    private router: Router,
    private zone: NgZone,
    private route: ActivatedRoute,
  ) {
  }

  ngOnInit(): void {
    if (this.widget) {
      this.miningWindowPreference = '1w';
    } else {
      this.seoService.setTitle($localize`:@@fe5317c6c60dd7e0e86f04d22f566f67cf04d404:Mining Pools`);
      this.seoService.setDescription($localize`:@@meta.description.bitcoin.graphs.pool-ranking:See the top Bitcoin mining pools ranked by number of blocks mined, over your desired timeframe.`);
      this.miningWindowPreference = this.miningService.getDefaultTimespan('24h');
    }
    this.radioGroupForm = this.formBuilder.group({ dateSpan: this.miningWindowPreference });
    this.radioGroupForm.controls.dateSpan.setValue(this.miningWindowPreference);

    this.indexingAvailable = (this.stateService.env.BASE_MODULE === 'mempool' &&
      this.stateService.env.MINING_DASHBOARD === true);
    this.auditAvailable = this.indexingAvailable && this.stateService.env.AUDIT;

    this.route
      .fragment
      .subscribe((fragment) => {
        if (['24h', '3d', '1w', '1m', '3m', '6m', '1y', '2y', '3y', 'all'].indexOf(fragment) > -1) {
          this.radioGroupForm.controls.dateSpan.setValue(fragment, { emitEvent: false });
        }
      });

    this.miningStatsObservable$ = merge(
      this.radioGroupForm.get('dateSpan').valueChanges
        .pipe(
          startWith(this.radioGroupForm.controls.dateSpan.value), // (trigger when the page loads)
          tap((value) => {
            this.isLoading = true;
            this.timespan = value;
            if (!this.widget) {
              this.storageService.setValue('miningWindowPreference', value);
            }
            this.miningWindowPreference = value;
          }),
          switchMap(() => {
            return this.miningService.getMiningStats(this.miningWindowPreference);
          })
        ),
        this.stateService.chainTip$
          .pipe(
            switchMap(() => {
              return this.miningService.getMiningStats(this.miningWindowPreference);
            })
          )
      )
      .pipe(
        map(data => {
          data['minersLuck'] = (100 * (data.blockCount / 1008)).toFixed(2); // luck 1w
          return data;
        }),
        tap(data => {
          this.isLoading = false;
          this.lastMiningStats = data;
          this.prepareChartOptions(data);
        }),
        shareReplay(1)
      );
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['antPoolProxy'] && !changes['antPoolProxy'].firstChange && this.lastMiningStats) {
      this.prepareChartOptions(this.lastMiningStats);
      if (this.chartInstance) {
        this.chartInstance.setOption(this.chartOptions);
      }
    }
  }

  generatePoolsChartSerieData(miningStats) {
    let poolShareThreshold = 0;   // 0 = mostrar TODOS los mineros (sin agrupar en "Otros")
    if (isMobile()) {
      poolShareThreshold = 0.3;   // en móvil el queso es pequeño: agrupamos los diminutos
    } else if (this.widget) {
      poolShareThreshold = 0;   // en /es/mining (widget) tambien: TODOS los mineros
    }

    let pools = miningStats.pools;
    if (this.antPoolProxy) {
      pools = this.regroupAntPoolProxy(miningStats.pools, miningStats);
    }

    // "Independent miners": opcionalmente agrupamos la cola de mineros más pequeños
    // en una sola porción. GROUP_INDEPENDENT=false → se muestran TODOS los mineros
    // (el queso se estira en alto para que quepan, ver chartHeight). Poner a true y
    // ajustar INDEP_TARGET para volver a agrupar la cola en ~ese % del total.
    const GROUP_INDEPENDENT = false;
    const INDEP_TARGET = 13; // % objetivo del grupo agrupado (si GROUP_INDEPENDENT)
    const grouped = new Set<any>();
    if (GROUP_INDEPENDENT && this.widget && !isMobile()) {
      const asc = [...pools].sort((a, b) => parseFloat(a.share) - parseFloat(b.share));
      let acc = 0;
      for (const p of asc) {
        const s = parseFloat(p.share);
        if (acc + s > 15) { break; }
        grouped.add(p);
        acc += s;
        if (acc >= INDEP_TARGET) { break; }
      }
    }

    const data: object[] = [];
    let totalShareOther = 0;
    let totalBlockOther = 0;
    let totalEstimatedHashrateOther = 0;

    let edgeDistance: any = '8%';
    if (isMobile() && this.widget) {
      edgeDistance = 0;
    } else if (isMobile() && !this.widget || this.widget) {
      edgeDistance = 10;
    }

    pools.forEach((pool) => {
      if (grouped.has(pool) || parseFloat(pool.share) < poolShareThreshold) {
        totalShareOther += parseFloat(pool.share);
        totalBlockOther += pool.blockCount;
        totalEstimatedHashrateOther += pool.lastEstimatedHashrate;
        return;
      }
      data.push({
        itemStyle: {
          color: poolsColor[pool.name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()],
        },
        value: pool.share,
        name: pool.name + ((isMobile() || this.widget) ? `` : ` (${pool.share}%)`),
        label: {
          overflow: 'none',
          color: 'var(--grey)',
          alignTo: 'edge',
          edgeDistance: edgeDistance,
        },
        tooltip: {
          show: !isMobile() || !this.widget,
          backgroundColor: 'rgba(17, 19, 31, 1)',
          borderRadius: 4,
          shadowColor: 'rgba(0, 0, 0, 0.5)',
          textStyle: {
            color: 'var(--tooltip-grey)',
          },
          borderColor: '#000',
          formatter: () => {
            const i = pool.blockCount.toString();
            if (['24h', '3d', '1w'].includes(this.miningWindowPreference)) {
              let hashrate = pool.lastEstimatedHashrate;
              if ('3d' === this.miningWindowPreference) { hashrate = pool.lastEstimatedHashrate3d; }
              if ('1w' === this.miningWindowPreference) { hashrate = pool.lastEstimatedHashrate1w; }
              // hashrate ya viene dividido por hashrateDivider; deshacemos y pasamos a TH/s (÷1e12)
              const ths = hashrate * miningStats.miningUnits.hashrateDivider / 1e12;
              return `<b style="color: white">${pool.name} (${pool.share}%)</b><br>` +
                ths.toFixed(2) + ' TH/s' +
                `<br>` + $localize`${ i }:INTERPOLATION: blocks`;
            } else {
              return `<b style="color: white">${pool.name} (${pool.share}%)</b><br>` +
                $localize`${ i }:INTERPOLATION: blocks`;
            }
          }
        },
        data: pool.slug,
      } as PieSeriesOption);
    });

    const percentage = totalShareOther.toFixed(2) + '%';

    // 'Other' (solo si queda algo agrupado; con umbral 0 no se pinta)
    if (totalShareOther > 0) {
    data.push({
      itemStyle: {
        color: '#6b6b6b',
      },
      value: totalShareOther,
      name:  $localize`Independent miners (${percentage})`,
      label: {
        overflow: 'none',
        color: 'var(--grey)',
        alignTo: 'edge',
        edgeDistance: edgeDistance
      },
      tooltip: {
        backgroundColor: 'rgba(17, 19, 31, 1)',
        borderRadius: 4,
        shadowColor: 'rgba(0, 0, 0, 0.5)',
        textStyle: {
          color: 'var(--tooltip-grey)',
        },
        borderColor: '#000',
        formatter: () => {
          const i = totalBlockOther.toString();
          if (['24h', '3d', '1w'].includes(this.miningWindowPreference)) {
            return `<b style="color: white">` + $localize`Independent miners (${percentage})` + `</b><br>` + (totalEstimatedHashrateOther * miningStats.miningUnits.hashrateDivider / 1e12).toFixed(2) + ' TH/s' + `<br>` + $localize`${ i }:INTERPOLATION: blocks`;
          } else {
            return `<b style="color: white">` + $localize`Independent miners (${percentage})` + `</b><br>` + $localize`${ i }:INTERPOLATION: blocks`;
          }
        }
      },
      data: 9999 as any,
    } as PieSeriesOption);
    }

    return data;
  }

  prepareChartOptions(miningStats) {
    let pieSize = ['20%', '80%']; // Desktop
    if (isMobile() && !this.widget) {
      pieSize = ['15%', '60%'];
    }

    const serieData = this.generatePoolsChartSerieData(miningStats);

    // Alto adaptativo: con muchos pools sin agrupar, las etiquetas se reparten en las
    // dos columnas (izq/dcha). Damos ~24px por etiqueta y columna para que TODAS quepan
    // sin solaparse, aunque la página quede muy larga. Nunca menos que el alto pedido.
    if (this.widget && !isMobile()) {
      const perColumn = Math.ceil(serieData.length / 2);
      this.chartHeight = Math.max(this.height, perColumn * 24 + 220);
    } else {
      this.chartHeight = this.height;
    }

    this.chartOptions = {
      animation: false,
      color: chartColors.filter(color => color !== '#FDD835'),
      tooltip: {
        trigger: 'item',
        textStyle: {
          align: 'left',
        }
      },
      series: [
        {
          zlevel: 0,
          minShowLabelAngle: 0,
          name: 'Mining pool',
          type: 'pie',
          radius: pieSize,
          data: serieData,
          labelLayout: {
            hideOverlap: false,       // no ocultar nombres aunque casi se solapen
            moveOverlap: 'shiftY',    // separar verticalmente las etiquetas que chocan (clave para que se lean con muchos pools)
          },
          labelLine: {
            lineStyle: {
              width: 2,
            },
          },
          label: {
            fontSize: 11,   // algo más pequeña para que quepan más nombres sin solaparse
            formatter: (serie) => `${serie.name === 'Binance Pool' ? 'Binance\nPool' : serie.name}`,
          },
          itemStyle: {
            borderRadius: 1,
            borderWidth: 1,
            borderColor: 'var(--bg)',
          },
          emphasis: {
            itemStyle: {
              shadowBlur: 40,
              shadowColor: 'var(--bg)',
            },
            labelLine: {
              lineStyle: {
                width: 3,
              }
            }
          }
        }
      ],
    };
  }

  onChartInit(ec) {
    if (this.chartInstance !== undefined) {
      return;
    }

    this.chartInstance = ec;
    this.chartInstance.on('click', (e) => {
      if (e.data.data === 9999) { // "Other"
        return;
      }
      this.zone.run(() => {
        const url = new RelativeUrlPipe(this.stateService).transform(`/mining/pool/${e.data.data}`);
        this.router.navigate([url]);
      });
    });
  }

  /**
   * Default mining stats if something goes wrong
   */
  getEmptyMiningStat(): MiningStats {
    return {
      lastEstimatedHashrate: 0,
      lastEstimatedHashrate3d: 0,
      lastEstimatedHashrate1w: 0,
      blockCount: 0,
      totalEmptyBlock: 0,
      totalEmptyBlockRatio: '',
      pools: [],
      totalBlockCount: 0,
      miningUnits: {
        hashrateDivider: 1,
        hashrateUnit: '',
      },
    };
  }

  onSaveChart() {
    const now = new Date();
    this.chartOptions.backgroundColor = 'var(--active-bg)';
    this.chartInstance.setOption(this.chartOptions);
    download(this.chartInstance.getDataURL({
      pixelRatio: 2,
      excludeComponents: ['dataZoom'],
    }), `pools-ranking-${this.timespan}-${Math.round(now.getTime() / 1000)}.svg`);
    this.chartOptions.backgroundColor = 'none';
    this.chartInstance.setOption(this.chartOptions);
  }

  isEllipsisActive(e) {
    return (e.offsetWidth < e.scrollWidth);
  }

  regroupAntPoolProxy(pools: any[], miningStats: any): any[] {
    // "PYBLOCK Proxy": junta en una sola porcion a todos los mineros cuyo nombre
    // contenga "PYBLOCK" (PyBLOCK-BIP110, etc.).
    const isPyblock = (p: any) => /pyblock/i.test(p.name || '');

    const poolsToMerge = pools.filter(isPyblock);
    if (poolsToMerge.length <= 1) {
      return pools;   // nada que juntar
    }

    const newPools = pools.filter(p => !isPyblock(p)).map(p => ({...p}));

    const merged: any = {...poolsToMerge[0]};
    merged.name = 'PYBLOCK';
    merged.slug = 'pyblock';
    for (let i = 1; i < poolsToMerge.length; i++) {
      merged.blockCount += poolsToMerge[i].blockCount;
      merged.lastEstimatedHashrate += poolsToMerge[i].lastEstimatedHashrate || 0;
      merged.lastEstimatedHashrate3d += poolsToMerge[i].lastEstimatedHashrate3d || 0;
      merged.lastEstimatedHashrate1w += poolsToMerge[i].lastEstimatedHashrate1w || 0;
    }

    const totalBlocks = miningStats.pools.reduce((sum, p) => sum + p.blockCount, 0);
    merged.share = ((merged.blockCount / totalBlocks) * 100).toFixed(2);

    newPools.push(merged);
    newPools.sort((a, b) => b.blockCount - a.blockCount);

    return newPools;
  }
}

