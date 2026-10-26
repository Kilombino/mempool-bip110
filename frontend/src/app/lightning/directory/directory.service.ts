import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { BehaviorSubject, Observable, of } from 'rxjs';
import { catchError, map, shareReplay, switchMap } from 'rxjs/operators';

// The node directory is a JSON file (resources/lightning-directory.json) mounted into the web
// container, so entries change without rebuilding the site. Node operators log in through the
// ln-directory service (/api/ln-directory/*) by signing a one-time text with their node key, and
// then write their own card; `notes` is ours alone.
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

// Lightning2Lightning reputation (0-100, read from the chain by ln-directory) of every node.
export interface L2LScores {
  nodes: { [publicKey: string]: { score: number, rings: number, opened: number, missed: number } };
}
export const L2L_SITE = 'https://nodex.kilombino.com';

export interface DirectoryLoginText {
  ok: boolean;
  text: string;
  expires: string;
}

export interface DirectorySession {
  ok: boolean;
  pubkey: string;
  alias: string;
  csrf: string;
  expires: string;
  entry: DirectoryEntry | null;
}

const API = '/api/ln-directory';

@Injectable({ providedIn: 'root' })
export class LightningDirectoryService {
  private directory$: Observable<Directory>;
  private scores$: Observable<L2LScores>;
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

  // Without the L2L API (older ln-directory) every node simply has no score.
  getScores$(): Observable<L2LScores> {
    if (!this.scores$) {
      this.scores$ = this.http.get<L2LScores>(`${API}/l2l/scores`).pipe(
        map((d) => ({ nodes: d?.nodes || {} })),
        catchError(() => of({ nodes: {} })),
        shareReplay(1),
      );
    }
    return this.scores$;
  }

  refresh(): void {
    this.version$.next(Date.now());
  }

  getEntry$(publicKey: string): Observable<DirectoryEntry | null> {
    return this.getDirectory$().pipe(map((d) => d.nodes[publicKey] || null));
  }

  // Session calls. The session cookie is HttpOnly and SameSite=Strict; state-changing calls
  // also send the session's CSRF token in a header ("login" before there is a session).
  private headers(csrf: string): { headers: HttpHeaders } {
    return { headers: new HttpHeaders({ 'X-LnDir-CSRF': csrf }) };
  }

  // 200 in both cases; without a session the answer has no pubkey (logged_in: false).
  me$(): Observable<DirectorySession> {
    return this.http.get<DirectorySession>(`${API}/me`);
  }

  loginText$(): Observable<DirectoryLoginText> {
    return this.http.post<DirectoryLoginText>(`${API}/login/challenge`, {}, this.headers('login'));
  }

  login$(challenge: string, signature: string): Observable<DirectorySession> {
    return this.http.post<DirectorySession>(`${API}/login`, { challenge, signature }, this.headers('login'));
  }

  saveCard$(csrf: string, entry: DirectoryEntry): Observable<{ ok: boolean, result: string, entry: DirectoryEntry }> {
    return this.http.put<any>(`${API}/card`, { entry }, this.headers(csrf));
  }

  deleteCard$(csrf: string): Observable<{ ok: boolean, result: string }> {
    return this.http.delete<any>(`${API}/card`, this.headers(csrf));
  }

  logout$(csrf: string, everywhere = false): Observable<{ ok: boolean, revoked?: number }> {
    return this.http.post<any>(`${API}/${everywhere ? 'logout-all' : 'logout'}`, {}, this.headers(csrf));
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
