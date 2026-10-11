import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Observable, of } from 'rxjs';
import { catchError, map, shareReplay, switchMap } from 'rxjs/operators';

// The node directory is a JSON file (resources/lightning-directory.json) mounted into the web
// container, so entries change without rebuilding the site. Node operators write their own card
// through the ln-directory service (/api/ln-directory/*) by signing a one-time text with their
// node key; `notes` is ours alone.
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

export interface DirectoryChallenge {
  ok: boolean;
  action: 'publish' | 'delete';
  text: string;
  expires: string;
  entry?: DirectoryEntry;
}

@Injectable({ providedIn: 'root' })
export class LightningDirectoryService {
  private directory$: Observable<Directory>;
  // Cache buster: changes every 5 minutes, and right after our own edits.
  private version$ = new BehaviorSubject<number>(Math.floor(Date.now() / 300000));

  constructor(private http: HttpClient) { }

  getDirectory$(): Observable<Directory> {
    if (!this.directory$) {
      this.directory$ = this.version$.pipe(
        switchMap((v) => this.http.get<Directory>(`/resources/lightning-directory.json?v=${v}`).pipe(
          map((d) => ({ updated: d?.updated, nodes: d?.nodes || {} })),
          catchError(() => of({ nodes: {} })),
        )),
        shareReplay(1),
      );
    }
    return this.directory$;
  }

  refresh(): void {
    this.version$.next(Date.now());
  }

  getEntry$(publicKey: string): Observable<DirectoryEntry | null> {
    return this.getDirectory$().pipe(map((d) => d.nodes[publicKey] || null));
  }

  getChallenge$(pubkey: string, action: 'publish' | 'delete', entry?: DirectoryEntry): Observable<DirectoryChallenge> {
    return this.http.post<DirectoryChallenge>('/api/ln-directory/challenge', { pubkey, action, entry });
  }

  submit$(pubkey: string, challenge: string, signature: string, entry: DirectoryEntry): Observable<{ ok: boolean, result: string, entry: DirectoryEntry }> {
    return this.http.post<any>('/api/ln-directory/submit', { pubkey, challenge, signature, entry });
  }

  delete$(pubkey: string, challenge: string, signature: string): Observable<{ ok: boolean, result: string }> {
    return this.http.post<any>('/api/ln-directory/delete', { pubkey, challenge, signature });
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
    case 'discord':
    case 'simplex': return /^https:\/\//.test(v) ? v : null;
    default: return null;
  }
}
