import { Component, OnInit, OnDestroy, Input, ViewChild } from '@angular/core';
import { Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { Env, StateService } from '@app/services/state.service';
import { Observable, merge, of, Subscription, timer } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { LanguageService } from '@app/services/language.service';
import { EnterpriseService } from '@app/services/enterprise.service';
import { NavigationService } from '@app/services/navigation.service';
import { MenuComponent } from '@components/menu/menu.component';
import { StorageService } from '@app/services/storage.service';

@Component({
  selector: 'app-master-page',
  templateUrl: './master-page.component.html',
  styleUrls: ['./master-page.component.scss'],
  standalone: false,
})
export class MasterPageComponent implements OnInit, OnDestroy {
  @Input() headerVisible = true;
  @Input() footerVisibleOverride: boolean | null = null;

  env: Env;
  network$: Observable<string>;
  connectionState$: Observable<number>;
  navCollapsed = false;
  isMobile = window.innerWidth <= 767.98;
  officialMempoolSpace = this.stateService.env.OFFICIAL_MEMPOOL_SPACE;
  officialMempoolSpaceBuild = this.stateService.isMempoolSpaceBuild;
  urlLanguage: string;
  subdomain = '';
  networkPaths: { [network: string]: string };
  networkPaths$: Observable<Record<string, string>>;
  footerVisible = true;
  user: any = undefined;
  servicesEnabled = false;
  menuOpen = false;
  isDropdownVisible: boolean;

  enterpriseInfo: any;
  enterpriseInfo$: Subscription;

  // Precio de Bitcoin-Blake2b desde neoxa, mostrado en el header (par USDC y par BTC).
  btcb2Price: number | null = null;
  btcb2ChangePercent: number | null = null;
  btcb2BtcSats: number | null = null;
  btcb2BtcChangePercent: number | null = null;
  priceSub: Subscription;
  // Rendimiento por TH/s (como pool.awokenlazarus.xyz): 1 TH/s ≈ X Poolcoins/Day · $Y
  networkDifficulty: number | null = null;
  blockSubsidyBtc: number | null = null;
  thsBtcDay: number | null = null;
  thsUsdDay: number | null = null;
  // Coste de alquiler más barato de 1 TH/s en MiningRigRentals (BTC real) + su equivalente en $.
  mrrBtcPerThDay: number | null = null;
  mrrUsdPerThDay: number | null = null;
  private realBtcUsd: number | null = null;

  @ViewChild(MenuComponent)
  public menuComponent!: MenuComponent;

  constructor(
    public stateService: StateService,
    private languageService: LanguageService,
    private enterpriseService: EnterpriseService,
    private navigationService: NavigationService,
    private storageService: StorageService,
    private router: Router,
    private http: HttpClient,
  ) { }

  private startBtcb2PricePolling(): void {
    this.priceSub = timer(0, 60000).subscribe(() => {
      this.http.get<any>('/neoxa-ticker').pipe(catchError(() => of(null))).subscribe((res) => {
        const t = res && res.ticker ? res.ticker : null;
        if (t && typeof t.lastPrice === 'number') {
          this.btcb2Price = t.lastPrice;
          this.btcb2ChangePercent = typeof t.changePercent === 'number' ? t.changePercent : null;
          this.recomputeYields();
        }
      });
      this.http.get<any>('/neoxa-ticker-btc').pipe(catchError(() => of(null))).subscribe((res) => {
        const t = res && res.ticker ? res.ticker : null;
        if (t && typeof t.lastPrice === 'number') {
          this.btcb2BtcSats = Math.round(t.lastPrice * 100000000);
          this.btcb2BtcChangePercent = typeof t.changePercent === 'number' ? t.changePercent : null;
        }
      });
      // Dificultad de red (para el rendimiento por TH/s), igual que la web de Lazarus.
      this.http.get<any>('/api/v1/mining/hashrate/3d').pipe(catchError(() => of(null))).subscribe((res) => {
        if (res && typeof res.currentDifficulty === 'number' && res.currentDifficulty > 0) {
          this.networkDifficulty = res.currentDifficulty;
          this.recomputeYields();
        }
      });
      this.http.get<any>('/api/blocks/tip/height').pipe(catchError(() => of(null))).subscribe((h) => {
        const height = typeof h === 'number' ? h : parseInt(h, 10);
        if (!isNaN(height)) {
          this.blockSubsidyBtc = 50 / Math.pow(2, Math.floor(height / 210000));
          this.recomputeYields();
        }
      });
      // Coste de alquiler más barato de 1 TH/s en MiningRigRentals (BTC real) + precio BTC real para el $.
      this.http.get<any>('/mrr-cheapest').pipe(catchError(() => of(null))).subscribe((res) => {
        const rec = res && res.data && res.data.records && res.data.records[0];
        const p = rec && rec.price && rec.price.BTC ? parseFloat(rec.price.BTC.price) : NaN;
        if (!isNaN(p) && p > 0) { this.mrrBtcPerThDay = p; this.recomputeRentCost(); }
      });
      this.http.get<any>('/btc-usd').pipe(catchError(() => of(null))).subscribe((res) => {
        const r = res && res.result ? res.result : null;
        const key = r ? Object.keys(r)[0] : null;
        const px = key && r[key] && r[key].c ? parseFloat(r[key].c[0]) : NaN;
        if (!isNaN(px) && px > 0) { this.realBtcUsd = px; this.recomputeRentCost(); }
      });
    });
  }

  private recomputeRentCost(): void {
    if (this.mrrBtcPerThDay && this.realBtcUsd) {
      this.mrrUsdPerThDay = this.mrrBtcPerThDay * this.realBtcUsd;
    }
  }

  /**
   * 1 TH/s ≈ X Poolcoins/Day · $Y. Se mide como en pool.awokenlazarus.xyz, a partir de
   * la DIFICULTAD (no del hashrate medio): coins/día por TH/s = subsidio × 86400 × 1e12 /
   * (dificultad × 2^34). El 2^34 es la relación work↔dificultad de este PoW BLAKE2b
   * (verificado contra su /api/pool: da ~0.055, no ~0.085 del hashrate medio de 3 días).
   */
  private recomputeYields(): void {
    if (!this.networkDifficulty || !this.blockSubsidyBtc) { return; }
    this.thsBtcDay = this.blockSubsidyBtc * 86400 * 1e12 / (this.networkDifficulty * Math.pow(2, 34));
    this.thsUsdDay = this.btcb2Price ? this.thsBtcDay * this.btcb2Price : null;
  }

  ngOnInit(): void {
    this.env = this.stateService.env;
    this.startBtcb2PricePolling();
    this.connectionState$ = this.stateService.connectionState$;
    this.network$ = merge(of(''), this.stateService.networkChanged$);
    this.urlLanguage = this.languageService.getLanguageForUrl();
    this.subdomain = this.enterpriseService.getSubdomain();
    this.navigationService.subnetPaths.subscribe((paths) => {
      this.networkPaths = paths;
      if (this.footerVisibleOverride === null) {
        if (paths.mainnet.indexOf('docs') > -1) {
          this.footerVisible = false;
        } else {
          this.footerVisible = true;
        }
      } else {
        this.footerVisible = this.footerVisibleOverride;
      }
    });
    this.enterpriseInfo$ = this.enterpriseService.info$.subscribe(info => {
      this.enterpriseInfo = info;
    });

    this.servicesEnabled = this.officialMempoolSpace && this.stateService.env.ACCELERATOR === true && this.stateService.network === '';
    this.refreshAuth();

    const isServicesPage = this.router.url.includes('/services/');
    this.menuOpen = isServicesPage && !this.isSmallScreen();
    this.setDropdownVisibility();
  }

  get networkDisplayName(): string {
    return this.stateService.networkDisplayName;
  }

  setDropdownVisibility(): void {
    const networks = [
      this.env.TESTNET_ENABLED,
      this.env.TESTNET4_ENABLED,
      this.env.SIGNET_ENABLED,
      this.env.REGTEST_ENABLED,
      this.env.LIQUID_ENABLED,
      this.env.LIQUID_TESTNET_ENABLED,
      this.env.MAINNET_ENABLED,
    ];
    const enabledNetworksCount = networks.filter((networkEnabled) => networkEnabled).length;
    this.isDropdownVisible = enabledNetworksCount > 1;
  }

  collapse(): void {
    this.navCollapsed = !this.navCollapsed;
  }

  isSmallScreen(): boolean {
    return window.innerWidth <= 767.98;
  }

  onResize(): void {
    this.isMobile = this.isSmallScreen();
  }

  brandClick(e): void {
    this.stateService.resetScroll$.next(true);
  }

  onLoggedOut(): void {
    this.refreshAuth();
  }

  refreshAuth(): void {
    this.user = this.storageService.getAuth()?.user ?? null;
  }

  hamburgerClick(event): void {
    if (this.menuComponent) {
      this.menuComponent.hamburgerClick();
      this.menuOpen = this.menuComponent.navOpen;
      event.stopPropagation();
    }
  }

  menuToggled(isOpen: boolean): void {
    this.menuOpen = isOpen;
  }

  ngOnDestroy(): void {
    if (this.enterpriseInfo$) {
      this.enterpriseInfo$.unsubscribe();
    }
    if (this.priceSub) {
      this.priceSub.unsubscribe();
    }
  }

}
