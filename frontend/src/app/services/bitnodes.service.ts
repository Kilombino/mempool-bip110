import { Injectable } from '@angular/core';
import { Observable, of } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';

export interface KnotsNodeStats {
  country: string;
  count: number;
  percentage: number;
}

export interface KnotsNodeTotals {
  totalNodes: number;
  ipv4Nodes: number;
  ipv6Nodes: number;
  clearnetNodes: number;
  torNodes: number;
  totalBitcoinNodes: number;
  percentageOfTotal: number;
  bipCount: number;
  rdtsCount: number;
  knotsActive: number;
}

export interface KnotsNodeResponse {
  countries: KnotsNodeStats[];
  totals: KnotsNodeTotals;
}

export interface Blake2bPeerVersion {
  version: string;
  count: number;
  inbound: number;
  outbound: number;
}

export interface Blake2bPeersResponse {
  total: number;
  versions: Blake2bPeerVersion[];
  updatedAt: number;
}

@Injectable({
  providedIn: 'root'
})
export class BitnodesService {
  private cache: {
    lastUpdated: number;
    data: KnotsNodeResponse;
  } | null = null;
  
  private readonly CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

  constructor(
    private http: HttpClient
  ) {}

  /**
   * Get Knots nodes distribution by country
   */
  getKnotsNodeDistribution(): Observable<KnotsNodeResponse> {
    // Check cache first
    if (this.cache && (Date.now() - this.cache.lastUpdated) < this.CACHE_DURATION) {
      return of(this.cache.data);
    }

    // Always use our backend endpoint to avoid CORS issues
    const apiUrl = '/api/v1/bitnodes/knots-stats';

    return this.http.get<KnotsNodeResponse>(apiUrl)
      .pipe(
        tap(data => {
          this.cache = {
            lastUpdated: Date.now(),
            data
          };
        }),
        catchError((error: HttpErrorResponse) => {
          console.error('Error fetching Bitnodes data:', error);
          return of({
            countries: [],
            totals: { 
              totalNodes: 0, 
              ipv4Nodes: 0,
              ipv6Nodes: 0,
              clearnetNodes: 0, 
              torNodes: 0,
              totalBitcoinNodes: 0,
              percentageOfTotal: 0,
              bipCount: 0,
              rdtsCount: 0,
              knotsActive: 0,
            }
          });
        })
      );
  }
  private peersCache: { lastUpdated: number; data: Blake2bPeersResponse } | null = null;
  private readonly PEERS_CACHE_DURATION = 45 * 1000; // 45 s

  /**
   * BLAKE2b peers connected to our node, grouped by client version (Knots rc4, rc3, ...)
   */
  getBlake2bPeersByVersion(): Observable<Blake2bPeersResponse> {
    if (this.peersCache && (Date.now() - this.peersCache.lastUpdated) < this.PEERS_CACHE_DURATION) {
      return of(this.peersCache.data);
    }
    return this.http.get<Blake2bPeersResponse>('/api/v1/blake2b/peers-by-version')
      .pipe(
        tap(data => {
          this.peersCache = { lastUpdated: Date.now(), data };
        }),
        catchError((error: HttpErrorResponse) => {
          console.error('Error fetching BLAKE2b peers by version:', error);
          return of({ total: 0, versions: [], updatedAt: Date.now() });
        })
      );
  }
}
