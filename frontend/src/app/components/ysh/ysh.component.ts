import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Subscription, of, timer } from 'rxjs';
import { catchError } from 'rxjs/operators';

/**
 * YSH — Your Security Hashrate: el punto de equilibrio entre lo que minas y lo que
 * tienes. Es el hashrate de la red repartido entre todas las monedas en circulación,
 * multiplicado por las que guardas: la parte de la seguridad de la cadena que te toca
 * pagar por tu propio dinero. Conviene rondarlo, sin quedarse corto ni pasarse mucho.
 *
 * Los mismos datos que el "YSH" del cabecero, sin endpoint propio: `currentHashrate`
 * de /api/v1/mining/hashrate/3d y el suministro emitido, que se calcula sumando los
 * subsidios de cada época de halving desde la altura de la punta.
 */
@Component({
  selector: 'app-ysh',
  templateUrl: './ysh.component.html',
  styleUrls: ['./ysh.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class YshComponent implements OnInit, OnDestroy {
  /** Lo que escribe el usuario, en BTC. Se admiten decimales (hasta 8, como un satoshi). */
  amount = 1;

  /**
   * Lo que el usuario mina de verdad, en TH/s. Es opcional: vacío o 0 significa
   * "solo quiero saber el objetivo". En cuanto pone algo, se compara con su YSH,
   * que es donde el concepto de punto de equilibrio cobra sentido.
   */
  minedThs: number | null = null;

  networkHashrate: number | null = null;   // H/s
  circulatingSupply: number | null = null; // BTC emitidos
  blockHeight: number | null = null;

  /** Coste de alquiler más barato de 1 TH/s al día, en BTC real, y el precio del BTC real. */
  mrrBtcPerThDay: number | null = null;
  realBtcUsd: number | null = null;

  /** Minero de referencia, el mismo que usa el cabecero para la equivalencia en kWh. */
  readonly minerName = 'Goldshell SC5 Pro II';
  readonly minerThs = 14;
  readonly minerWatts = 3300;

  private sub: Subscription;

  constructor(private http: HttpClient, private cd: ChangeDetectorRef) { }

  ngOnInit(): void {
    this.sub = timer(0, 60000).subscribe(() => {
      this.http.get<any>('/api/v1/mining/hashrate/3d').pipe(catchError(() => of(null))).subscribe((res) => {
        if (res && typeof res.currentHashrate === 'number' && res.currentHashrate > 0) {
          this.networkHashrate = res.currentHashrate;
          this.cd.markForCheck();
        }
      });
      this.http.get<any>('/api/blocks/tip/height').pipe(catchError(() => of(null))).subscribe((h) => {
        const height = typeof h === 'number' ? h : parseInt(h, 10);
        if (!isNaN(height)) {
          this.blockHeight = height;
          this.circulatingSupply = this.supplyAtHeight(height);
          this.cd.markForCheck();
        }
      });
      this.http.get<any>('/mrr-cheapest').pipe(catchError(() => of(null))).subscribe((res) => {
        const rec = res && res.data && res.data.records && res.data.records[0];
        const p = rec && rec.price && rec.price.BTC ? parseFloat(rec.price.BTC.price) : NaN;
        if (!isNaN(p) && p > 0) { this.mrrBtcPerThDay = p; this.cd.markForCheck(); }
      });
      this.http.get<any>('/btc-usd').pipe(catchError(() => of(null))).subscribe((res) => {
        const r = res && res.result ? res.result : null;
        const key = r ? Object.keys(r)[0] : null;
        const px = key && r[key] && r[key].c ? parseFloat(r[key].c[0]) : NaN;
        if (!isNaN(px) && px > 0) { this.realBtcUsd = px; this.cd.markForCheck(); }
      });
    });
  }

  ngOnDestroy(): void {
    if (this.sub) { this.sub.unsubscribe(); }
  }

  onAmountChange(value: string): void {
    // Se acepta coma o punto como separador decimal; quien escribe en español usa coma.
    const n = parseFloat((value || '').replace(',', '.'));
    this.amount = isNaN(n) || n < 0 ? 0 : n;
    this.cd.markForCheck();
  }

  onMinedChange(value: string): void {
    const n = parseFloat((value || '').replace(',', '.'));
    this.minedThs = isNaN(n) || n < 0 ? null : n;
    this.cd.markForCheck();
  }

  /** BTC emitidos hasta una altura: suma de los subsidios de cada época de halving. */
  private supplyAtHeight(height: number): number {
    let supply = 0;
    let subsidy = 50;
    let start = 0;
    while (start <= height && subsidy > 0) {
      supply += Math.min(height - start + 1, 210000) * subsidy;
      subsidy /= 2;
      start += 210000;
    }
    return supply;
  }

  get ready(): boolean {
    return this.networkHashrate !== null && this.circulatingSupply !== null && this.circulatingSupply > 0;
  }

  /** Hashrate que respalda cada BTC, en H/s. */
  get hashPerBtc(): number | null {
    return this.ready ? this.networkHashrate / this.circulatingSupply : null;
  }

  /** Hashrate que le correspondería a la cantidad introducida, en H/s. */
  get yourHashrate(): number | null {
    const per = this.hashPerBtc;
    return per === null ? null : per * this.amount;
  }

  /** Porcentaje de la red que representa esa cantidad. */
  get shareOfNetwork(): number | null {
    const y = this.yourHashrate;
    return y === null || !this.networkHashrate ? null : 100 * y / this.networkHashrate;
  }

  /** Cuántos mineros de referencia harían falta (con decimales: casi nunca sale un número entero). */
  get minersNeeded(): number | null {
    const y = this.yourHashrate;
    return y === null ? null : y / (this.minerThs * 1e12);
  }

  /** Consumo de esa potencia de cálculo, en vatios. */
  get watts(): number | null {
    const m = this.minersNeeded;
    return m === null ? null : m * this.minerWatts;
  }

  /** Lo que costaría alquilar ese hashrate un día, en dólares. */
  get rentUsdPerDay(): number | null {
    const y = this.yourHashrate;
    if (y === null || !this.mrrBtcPerThDay || !this.realBtcUsd) { return null; }
    return (y / 1e12) * this.mrrBtcPerThDay * this.realBtcUsd;
  }

  /** Lo que mina el usuario, en H/s, o null si no ha puesto nada. */
  get minedHashrate(): number | null {
    return this.minedThs && this.minedThs > 0 ? this.minedThs * 1e12 : null;
  }

  /** Cuánto se desvía de su punto de equilibrio: 1 = justo, 2 = el doble, 0,5 = la mitad. */
  get balanceRatio(): number | null {
    const target = this.yourHashrate;
    const mined = this.minedHashrate;
    if (target === null || mined === null || target <= 0) { return null; }
    return mined / target;
  }

  /** Qué parte de TODA la red controla lo que mina el usuario, en %. */
  get minedSharePercent(): number | null {
    const mined = this.minedHashrate;
    if (mined === null || !this.networkHashrate) { return null; }
    return 100 * mined / this.networkHashrate;
  }

  /**
   * El veredicto, como clave: el texto vive en la plantilla para que pase por i18n.
   *
   * Los umbrales de equilibrio son deliberadamente anchos (±25 %) porque ni el hashrate
   * de red ni lo que uno mina son cifras estables: afinar más sería precisión falsa.
   *
   * 🔑 Pasarse del YSH NO es lo que te convierte en atacante: eso depende de la parte de
   * la RED que controlas, no de la proporción con lo que guardas. Quien tenga 0,001 BTC
   * puede minar mil veces su YSH y seguir siendo irrelevante para la seguridad de la
   * cadena. Por eso la cuota de red se comprueba PRIMERO y manda sobre la proporción:
   * con mayoría de hashrate eres un peligro aunque tengas monedas de sobra para
   * "justificarlo". Umbrales: 50 % = mayoría (reorganizar la cadena y gastar dos veces);
   * 25 % = a partir de ahí retener bloques empieza a ser rentable (Eyal-Sirer).
   */
  get balanceKey(): string | null {
    const share = this.minedSharePercent;
    if (share !== null) {
      if (share >= 50) { return 'attack'; }
      if (share >= 25) { return 'danger'; }
    }
    const r = this.balanceRatio;
    if (r === null) { return null; }
    if (r < 0.75) { return 'under'; }
    if (r > 1.25) { return 'over'; }
    return 'even';
  }

  /** El % de su YSH que mina, ya formateado (para el texto del veredicto). */
  get ratioPercentText(): string {
    const r = this.balanceRatio;
    return r === null ? '—' : this.adaptive(r * 100, 0);
  }

  /** Cuántas VECES su YSH mina, ya formateado. */
  get ratioTimesText(): string {
    const r = this.balanceRatio;
    return r === null ? '—' : this.adaptive(r, 2);
  }

  /** Su cuota de la red, ya formateada. */
  get sharePercentText(): string {
    const s = this.minedSharePercent;
    return s === null ? '—' : this.adaptive(s, 1);
  }

  /**
   * Las cantidades que maneja la gente (1 BTC, media) dan cifras diminutas frente a una
   * red de decenas de PH/s, así que estos tres formateadores eligen decimales según el
   * orden de magnitud. Sin esto, con 1 BTC salía "0,00 × minero", "0 W" y "0,0000 %".
   */
  private adaptive(n: number, big = 2): string {
    const abs = Math.abs(n);
    let decimals: number;
    if (abs >= 100) { decimals = 0; }
    else if (abs >= 1) { decimals = big; }
    else if (abs === 0) { decimals = 0; }
    else { decimals = Math.min(12, Math.max(big, 1 - Math.floor(Math.log10(abs)) + 1)); }
    return n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  }

  get shareText(): string {
    const s = this.shareOfNetwork;
    return s === null ? '—' : `${this.adaptive(s, 4)} %`;
  }

  /**
   * Los textos van troceados en cifra + unidad porque las palabras ("W", "kWh/day",
   * "a whole machine would back…") viven en la plantilla, que es donde pasan por i18n.
   * Montarlos aquí dejaría la página en un solo idioma.
   */
  get wattsValueText(): string {
    const w = this.watts;
    return w === null ? '—' : this.adaptive(w);
  }

  get kwhPerDayText(): string {
    const w = this.watts;
    return w === null ? '—' : this.adaptive(w / 1000 * 24);
  }

  /**
   * Con cantidades normales hace falta una fracción mínima de un ASIC, y "0,00 equipos"
   * no dice nada. Por debajo de un equipo la plantilla le da la vuelta a la frase:
   * cuántos BTC respalda UNO de esos mineros, que sí se entiende.
   */
  get minersAtLeastOne(): boolean {
    const m = this.minersNeeded;
    return m !== null && m >= 1;
  }

  get minersNeededText(): string {
    const m = this.minersNeeded;
    return m === null ? '—' : this.adaptive(m);
  }

  get btcPerMinerText(): string {
    const per = this.hashPerBtc;
    return per ? this.adaptive((this.minerThs * 1e12) / per, 0) : '—';
  }

  /**
   * Formatea un hashrate en H/s con la unidad que mejor se lea. Se usa tanto para
   * la cifra grande como para el "por cada BTC", así que la escala la elige el valor.
   */
  formatHashrate(hs: number | null, decimals = 2): string {
    if (hs === null || !isFinite(hs)) { return '—'; }
    const units: [number, string][] = [
      [1e18, 'EH/s'], [1e15, 'PH/s'], [1e12, 'TH/s'],
      [1e9, 'GH/s'], [1e6, 'MH/s'], [1e3, 'kH/s'],
    ];
    for (const [factor, label] of units) {
      if (hs >= factor) {
        return `${(hs / factor).toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })} ${label}`;
      }
    }
    return `${hs.toLocaleString(undefined, { maximumFractionDigits: decimals })} H/s`;
  }
}
