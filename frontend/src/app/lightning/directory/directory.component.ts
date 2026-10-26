import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { Observable, combineLatest, of } from 'rxjs';
import { catchError, map, switchMap } from 'rxjs/operators';
import { ActivatedRoute } from '@angular/router';
import { SeoService } from '@app/services/seo.service';
import { LightningApiService } from '@app/lightning/lightning-api.service';
import { LightningDirectoryService, L2LScores, L2L_SITE, contactLink } from '@app/lightning/directory/directory.service';

@Component({
  selector: 'app-lightning-directory',
  templateUrl: './directory.component.html',
  styleUrls: ['./directory.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LightningDirectoryComponent implements OnInit {
  rows$: Observable<any[]>;
  updated$: Observable<string | undefined>;
  scores$: Observable<L2LScores>;
  l2lSite = L2L_SITE;
  contactLink = contactLink;
  contactKinds = ['telegram', 'nostr', 'email', 'website', 'x', 'discord', 'simplex'];
  initialPubkey = '';

  constructor(
    private route: ActivatedRoute,
    private directory: LightningDirectoryService,
    private lightningApi: LightningApiService,
    private seoService: SeoService,
  ) { }

  ngOnInit(): void {
    // /lightning/directory?node=<pubkey> opens the editor on that node (link from each node's card).
    const q = (this.route.snapshot.queryParamMap.get('node') || '').trim().toLowerCase();
    if (/^0[23][0-9a-f]{64}$/.test(q)) { this.initialPubkey = q; }
    this.seoService.setTitle($localize`:@@lightning.directory-title:Lightning node directory`);
    const dir$ = this.directory.getDirectory$();
    this.scores$ = this.directory.getScores$();
    this.updated$ = dir$.pipe(map((d) => d.updated));
    // Each listed node, joined with what the network graph says about it now.
    this.rows$ = dir$.pipe(
      switchMap((d) => {
        const keys = Object.keys(d.nodes);
        if (!keys.length) { return of([]); }
        return combineLatest(keys.map((k) => this.lightningApi.getNode$(k).pipe(catchError(() => of(null)), map((node) => ({
          publicKey: k, entry: d.nodes[k], node,
        })))));
      }),
      map((rows) => rows.sort((a, b) => (b.node?.capacity || 0) - (a.node?.capacity || 0))),
    );
    if (this.initialPubkey) { setTimeout(() => this.scrollToEditor(), 300); }
  }

  scrollToEditor(event?: Event): void {
    event?.preventDefault();
    document.getElementById('publish')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}
