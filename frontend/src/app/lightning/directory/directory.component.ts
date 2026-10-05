import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { Observable, combineLatest, of } from 'rxjs';
import { catchError, map, switchMap } from 'rxjs/operators';
import { SeoService } from '@app/services/seo.service';
import { LightningApiService } from '@app/lightning/lightning-api.service';
import { LightningDirectoryService, contactLink } from '@app/lightning/directory/directory.service';

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
  contactLink = contactLink;
  contactKinds = ['telegram', 'nostr', 'email', 'website', 'x', 'discord', 'simplex'];

  constructor(
    private directory: LightningDirectoryService,
    private lightningApi: LightningApiService,
    private seoService: SeoService,
  ) { }

  ngOnInit(): void {
    this.seoService.setTitle($localize`:@@lightning.directory-title:Lightning node directory`);
    const dir$ = this.directory.getDirectory$();
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
  }
}
