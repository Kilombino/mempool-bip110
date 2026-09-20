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
      this.miningWindowPreference = this.miningService.getDefaultTimespan('1w');
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

    // El backend trocea cada pool DATUM en UNA entrada por minero (mismo slug). Las reagrupamos
    // en UNA cuña por pool; los mineros internos se dibujan como BANDAS CONCÉNTRICAS (serie
    // 'custom' aparte, encima). Los no-DATUM (un minero) quedan sólidos. Igual que mempool.guide.
    const POOL_DISPLAY: { [slug: string]: string } = {
      datumminers: 'DATUM miners', datum: 'DATUM', alphapool: 'AlphaPool', iohzrd: 'iohzrd',
      lazarus: 'Lazarus', convoy: 'CONVOY', convoymining: 'CONVOY', solo: 'solo', b2pool: 'B2Pool',
      tides: 'TIDES', riptide: 'RIPTIDE', pyblockwavicles: 'PYBLOCK WAVICLES',
      pyblockcarouseldatum: 'PYBLOCK CAROUSEL', pyblock: 'PYBLOCK',
      omegapool: 'OmegaPool', ratum: 'RATUM', ocean: 'OCEAN',
    };
    const prettySlug = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

    const palette = chartColors.filter((c) => c !== '#FDD835');
    const hashSlug = (s: string): number => {
      let h = 0;
      for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) & 0x7fffffff; }
      return h;
    };

    // Consolidar todos los servicios PyBLOCK (carousel/chirp/wavicles/lotto/carousel-datum)
    // en UNA sola cuña 'PYBLOCK', como hace mempool.guide; los servicios quedan como bandas
    // internas. En la línea de bloques se siguen distinguiendo (eso es otro componente).
    const groupSlug = (s: string): string => (s && s.startsWith('pyblock')) ? 'pyblock' : s;
    // Agrupamos las entradas por slug → una cuña por pool, con su lista de mineros internos.
    const meta = new Map<string, any>();
    pools.forEach((pool) => {
      const gs = groupSlug(pool.slug);
      let m = meta.get(gs);
      if (!m) { m = { slug: gs, blockCount: 0, shareSum: 0, hashrate: 0, miners: [] }; meta.set(gs, m); }
      m.blockCount += pool.blockCount;
      m.shareSum += parseFloat(pool.share);
      m.hashrate += pool.lastEstimatedHashrate || 0;
      m.miners.push({ name: pool.name, blockCount: pool.blockCount });
    });
    const groups = Array.from(meta.values());
    groups.sort((a, b) => b.blockCount - a.blockCount);
    groups.forEach((g) => {
      // Cuña multi-minero (pool DATUM): SIEMPRE el nombre del pool, nunca el de un minero
      // suelto (evita que la cuña 'datum' salga como 'CONVOY' o 'solo' como 'Quai Network').
      g.name = (g.miners.length > 1) ? (POOL_DISPLAY[g.slug] || prettySlug(g.slug)) : g.miners[0].name;
      g.miners.sort((a, b) => b.blockCount - a.blockCount);
      const key = (g.name || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
      g.color = poolsColor[key] || poolsColor[g.slug] || palette[hashSlug(g.slug) % palette.length];
      g.share = g.shareSum.toFixed(2);
    });

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

    groups.forEach((g) => {
      if (g.shareSum < poolShareThreshold) {
        totalShareOther += g.shareSum;
        totalBlockOther += g.blockCount;
        totalEstimatedHashrateOther += g.hashrate;
        return;
      }
      data.push({
        itemStyle: {
          color: g.color,
        },
        value: g.share,
        name: g.name + ((isMobile() || this.widget) ? `` : ` (${g.share}%)`),
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
            const i = g.blockCount.toString();
            const minersLine = g.miners.length > 1 ? `<br>` + g.miners.length + ` miners (DATUM)` : ``;
            if (['24h', '3d', '1w'].includes(this.miningWindowPreference)) {
              // Usamos SIEMPRE el hashrate actual (lastEstimatedHashrate): el 1w/3d del fork
              // viene inflado (~300x). Ya está dividido por hashrateDivider; deshacemos y ÷1e12 → TH/s.
              const ths = g.hashrate * miningStats.miningUnits.hashrateDivider / 1e12;
              return `<b style="color: white">${g.name} (${g.share}%)</b><br>` +
                ths.toFixed(2) + ' TH/s' +
                `<br>` + $localize`${ i }:INTERPOLATION: blocks` + minersLine;
            } else {
              return `<b style="color: white">${g.name} (${g.share}%)</b><br>` +
                $localize`${ i }:INTERPOLATION: blocks` + minersLine;
            }
          }
        },
        data: g.slug,
        _miners: g.miners,
        _name: g.name,
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
    // Alto adaptativo por nº de pools (una cuña/etiqueta por pool).
    if (this.widget && !isMobile()) {
      const perColumn = Math.ceil(serieData.length / 2);
      this.chartHeight = Math.max(this.height, perColumn * 24 + 220);
    } else {
      this.chartHeight = this.height;
    }

    // Bandas concéntricas por minero, portado FIEL del bundle de mempool.guide (serie 'custom'
    // encima del pie). bandsData es un array PLANO: una entrada por BANDA (no por pool), cada una
    // con su arco angular (= la cuña del pool en el pie) y su rango radial 0..1 dentro del anillo.
    const bandTotal = (serieData as any[]).reduce((s, d) => s + parseFloat(d.value), 0) || 1;
    const innerFrac = parseFloat(String(pieSize[0])) / 100;
    const outerFrac = parseFloat(String(pieSize[1])) / 100;
    const MIN_BAND_DEPTH = 0.08;   // fracción radial mínima por banda (mempool.guide)
    const BAND_DARKEST = 0.42;     // luz de la banda interior (más oscura)
    const BAND_LIGHTEST = 0.72;    // luz de la banda exterior (más clara)
    const bandsData: any[] = [];
    let bandCum = 0;
    (serieData as any[]).forEach((d) => {
      const v = parseFloat(d.value);
      const startFrac = bandCum / bandTotal;
      bandCum += v;
      const endFrac = bandCum / bandTotal;
      const miners = d._miners;
      if (!miners || !miners.length) { return; }   // "Independent miners"/sin mineros → sin bandas
      const baseName = d._name;
      const poolTotal = miners.reduce((s, mm) => s + (mm.blockCount || 0), 0) || 1;
      // Personalizados = finders que NO son el genérico del pool ("Built by the pool").
      let r = miners.filter((mm) => (mm.name || '') !== baseName);
      const tinyThresh = 0.005 * poolTotal;   // agrupar la cola diminuta en "Other miners"
      const tiny = r.filter((mm) => (mm.blockCount || 0) < tinyThresh);
      r = r.filter((mm) => (mm.blockCount || 0) >= tinyThresh);
      const c = tiny.reduce((s, mm) => s + (mm.blockCount || 0), 0);
      const l = r.reduce((s, mm) => s + (mm.blockCount || 0), 0);
      const dd = Math.max(0, poolTotal - l - c);
      const f: any[] = [];
      if (dd > 0) { f.push({ name: $localize`Built by the pool`, blockCount: dd }); }
      if (c > 0) { f.push({ name: $localize`Other miners`, blockCount: c }); }
      f.push(...r.slice().reverse());
      if (!f.length) { return; }
      const p = f.reduce((s, mm) => s + (mm.blockCount || 0), 0) || 1;
      const M = Math.min(MIN_BAND_DEPTH, 0.5 / f.length);
      const E = 1 - M * f.length;
      let N = 0;
      f.forEach((R, G) => {
        const le = N;
        N += M + E * (R.blockCount || 0) / p;
        const L = BAND_DARKEST + (f.length > 1 ? G / (f.length - 1) : 0) * (BAND_LIGHTEST - BAND_DARKEST);
        bandsData.push({
          value: R.blockCount || 0,
          data: d.data,   // slug (para el click → /mining/pool/slug)
          name: R.name,
          blockCount: R.blockCount || 0,
          poolName: baseName,
          poolShare: (100 * (R.blockCount || 0) / poolTotal).toFixed(1),
          color: this.bandColor((d.itemStyle && d.itemStyle.color) || '#888', L),
          startAngle: startFrac,
          endAngle: endFrac,
          innerRadius: le,
          outerRadius: N,
        });
      });
    });

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
          minShowLabelAngle: 1.8,   // como awokenlazarus: oculta etiquetas en porciones diminutas
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
            borderColor: '#000',   // borde fino que separa las porciones (mineros) = look rayado
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
        },
        // Overlay "DATUM miners": una BANDA concéntrica por minero interno de cada pool, encima
        // del pie. INTERACTIVA (silent no activado) para que el hover muestre el tooltip de la
        // banda. renderItem dibuja UN sector por banda (bandsData es plano). Fiel a mempool.guide.
        {
          type: 'custom',
          coordinateSystem: 'none',
          z: 3,
          zlevel: 1,
          data: bandsData,
          tooltip: {
            show: !isMobile() || !this.widget,
            backgroundColor: 'rgba(17, 19, 31, 1)',
            borderRadius: 4,
            shadowColor: 'rgba(0, 0, 0, 0.5)',
            textStyle: {
              color: 'var(--tooltip-grey)',
            },
            borderColor: '#000',
            formatter: (p: any) => {
              const b = (p && p.data) || {};
              const blk = (b.blockCount || 0).toString();
              return `<b style="color: white">${b.name}</b><br>${b.poolName} · ${b.poolShare}%<br>` +
                $localize`${ blk }:INTERPOLATION: blocks`;
            },
          },
          renderItem: (params: any, api: any) => {
            const s = bandsData[params.dataIndex];
            if (!s) { return; }
            const w = api.getWidth();
            const h = api.getHeight();
            const cc = Math.min(w, h) / 2;
            const rInner = innerFrac * cc;
            const ring = (outerFrac - innerFrac) * cc;
            return {
              type: 'sector',
              shape: {
                cx: w / 2,
                cy: h / 2,
                r0: rInner + s.innerRadius * ring,
                r: rInner + s.outerRadius * ring,
                startAngle: -Math.PI / 2 + 2 * Math.PI * s.startAngle,
                endAngle: -Math.PI / 2 + 2 * Math.PI * s.endAngle,
                clockwise: true,
              },
              style: {
                fill: s.color,
                stroke: 'var(--bg)',
                lineWidth: 1,
              },
            };
          },
        } as any
      ],
    };
  }

  // Devuelve el color base con la LUZ (HSL L) fijada a targetL (0..1): rampa de tonos del pool.
  private bandColor(color: string, targetL: number): string {
    const rgb = this.hexToRgb(color);
    if (!rgb) { return color; }
    const hsl = this.rgbToHsl(rgb.r, rgb.g, rgb.b);
    return this.hslToCss(hsl.h, hsl.s, Math.max(0, Math.min(1, targetL)));
  }

  private hexToRgb(hex: string): { r: number, g: number, b: number } | null {
    if (!hex || hex[0] !== '#') { return null; }
    let h = hex.slice(1);
    if (h.length === 3) { h = h.split('').map((c) => c + c).join(''); }
    if (h.length !== 6) { return null; }
    const n = parseInt(h, 16);
    if (isNaN(n)) { return null; }
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  private rgbToHsl(r: number, g: number, b: number): { h: number, s: number, l: number } {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0; const l = (max + min) / 2;
    const dlt = max - min;
    if (dlt !== 0) {
      s = l > 0.5 ? dlt / (2 - max - min) : dlt / (max + min);
      switch (max) {
        case r: h = (g - b) / dlt + (g < b ? 6 : 0); break;
        case g: h = (b - r) / dlt + 2; break;
        default: h = (r - g) / dlt + 4; break;
      }
      h /= 6;
    }
    return { h, s, l };
  }

  private hslToCss(h: number, s: number, l: number): string {
    const hue2rgb = (p: number, q: number, t: number): number => {
      if (t < 0) { t += 1; }
      if (t > 1) { t -= 1; }
      if (t < 1 / 6) { return p + (q - p) * 6 * t; }
      if (t < 1 / 2) { return q; }
      if (t < 2 / 3) { return p + (q - p) * (2 / 3 - t) * 6; }
      return p;
    };
    let r: number, g: number, b: number;
    if (s === 0) {
      r = g = b = l;
    } else {
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1 / 3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1 / 3);
    }
    return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
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

