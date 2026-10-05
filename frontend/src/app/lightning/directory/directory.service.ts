import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { catchError, map, shareReplay } from 'rxjs/operators';

// The node directory is a hand-kept JSON file (resources/lightning-directory.json) mounted
// into the web container, so entries can be added without rebuilding the site. Each entry is
// what a node operator asked us to publish about their node: how to contact them, what they
// offer, and our own notes.
export interface DirectoryContacts {
  telegram?: string;
  nostr?: string;
  email?: string;
  website?: string;
  lightning_address?: string;
  x?: string;
  discord?: string;
  simplex?: string;
}

export interface DirectoryEntry {
  name?: string;
  description?: string;
  tags?: string[];
  contacts?: DirectoryContacts;
  min_channel_size?: number;
  notes?: string;
  since?: string;
  updated?: string;
}

export interface Directory {
  updated?: string;
  nodes: { [publicKey: string]: DirectoryEntry };
}

@Injectable({ providedIn: 'root' })
export class LightningDirectoryService {
  private directory$: Observable<Directory>;

  constructor(private http: HttpClient) { }

  getDirectory$(): Observable<Directory> {
    if (!this.directory$) {
      // Bust caches every 5 minutes so edits show up quickly.
      const v = Math.floor(Date.now() / 300000);
      this.directory$ = this.http.get<Directory>(`/resources/lightning-directory.json?v=${v}`).pipe(
        map((d) => ({ updated: d?.updated, nodes: d?.nodes || {} })),
        catchError(() => of({ nodes: {} })),
        shareReplay(1),
      );
    }
    return this.directory$;
  }

  getEntry$(publicKey: string): Observable<DirectoryEntry | null> {
    return this.getDirectory$().pipe(map((d) => d.nodes[publicKey] || null));
  }
}

// Links for each contact kind, built from what the operator gave us.
export function contactLink(kind: string, value: string): string | null {
  const v = (value || '').trim();
  switch (kind) {
    case 'telegram': return 'https://t.me/' + v.replace(/^@/, '').replace(/^https?:\/\/t\.me\//, '');
    case 'nostr': return 'https://njump.me/' + v.replace(/^nostr:/, '');
    case 'email': return 'mailto:' + v;
    case 'website': return /^https?:\/\//.test(v) ? v : 'https://' + v;
    case 'x': return 'https://x.com/' + v.replace(/^@/, '');
    default: return null;
  }
}
