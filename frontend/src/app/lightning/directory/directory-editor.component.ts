import { ChangeDetectionStrategy, ChangeDetectorRef, Component, Input, OnDestroy, OnInit } from '@angular/core';
import { FormBuilder, FormGroup } from '@angular/forms';
import { Subject, Subscription, of } from 'rxjs';
import { catchError, debounceTime, distinctUntilChanged, map, switchMap, take } from 'rxjs/operators';
import { ApiService } from '@app/services/api.service';
import { DirectoryChallenge, DirectoryEntry, LightningDirectoryService } from '@app/lightning/directory/directory.service';

const PUBKEY_RE = /^0[23][0-9a-f]{64}$/;

// Lets a node operator publish, edit or delete their own card: they fill the form, we give them
// a one-time text that names their node and the card's digest, they sign it with the node key and
// paste the signature back. The ln-directory service checks it with our LND.
@Component({
  selector: 'app-node-directory-editor',
  templateUrl: './directory-editor.component.html',
  styleUrls: ['./directory.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DirectoryEditorComponent implements OnInit, OnDestroy {
  @Input() initialPubkey: string;

  form: FormGroup;
  pubkey = '';
  alias = '';
  existing: DirectoryEntry | null = null;
  suggestions: { public_key: string, alias: string }[] = [];
  challenge: DirectoryChallenge | null = null;
  signature = '';
  busy = false;
  error = '';
  success = '';
  contactKinds = ['telegram', 'nostr', 'email', 'website', 'lightning_address', 'x', 'discord', 'simplex'];
  contactLabels: { [k: string]: string } = {
    telegram: 'Telegram', nostr: 'Nostr', email: 'Email', website: 'Web', lightning_address: 'Lightning address',
    x: 'X', discord: 'Discord', simplex: 'SimpleX',
  };
  contactHints: { [k: string]: string } = {
    telegram: '@username', nostr: 'npub1…', email: 'you@example.com', website: 'https://…', lightning_address: 'name@domain.com',
    x: '@username', discord: 'username', simplex: 'https://simplex.chat/contact#…',
  };
  fieldLabels: { [k: string]: string } = {
    name: $localize`:@@lightning.directory-edit-field-name:Name`,
    description: $localize`:@@lightning.directory-edit-field-description:Description`,
    tags: $localize`:@@lightning.directory-edit-field-tags:Tags`,
    min_channel_size: $localize`:@@lightning.directory-min-channel:Min. channel size`,
    entry: $localize`:@@lightning.directory-edit-field-card:Card`,
  };

  private search$ = new Subject<string>();
  private subs: Subscription[] = [];

  constructor(
    private fb: FormBuilder,
    private directory: LightningDirectoryService,
    private api: ApiService,
    private cd: ChangeDetectorRef,
  ) { }

  ngOnInit(): void {
    const contacts = {};
    for (const k of this.contactKinds) { contacts[k] = ['']; }
    this.form = this.fb.group({
      pubkeyInput: [''],
      name: [''],
      description: [''],
      tags: [''],
      min_channel_size: [''],
      contacts: this.fb.group(contacts),
    });
    // Editing the card after asking for the text makes that text useless: it names the card's digest.
    this.subs.push(this.form.valueChanges.subscribe(() => {
      if (this.challenge?.action === 'publish') { this.challenge = null; this.signature = ''; }
      this.success = '';
      this.cd.markForCheck();
    }));
    this.subs.push(this.form.get('pubkeyInput').valueChanges.pipe(
      map((v: string) => (v || '').trim()),
      debounceTime(300),
      distinctUntilChanged(),
    ).subscribe((v) => this.onPubkeyInput(v)));
    this.subs.push(this.search$.pipe(
      switchMap((q) => q.length < 3 ? of({ nodes: [] }) : this.api.lightningSearch$(q).pipe(catchError(() => of({ nodes: [] })))),
    ).subscribe((r: any) => {
      this.suggestions = (r?.nodes || []).slice(0, 6);
      this.cd.markForCheck();
    }));
    if (this.initialPubkey) {
      this.form.get('pubkeyInput').setValue(this.initialPubkey);
    }
  }

  ngOnDestroy(): void {
    this.subs.forEach((s) => s.unsubscribe());
  }

  onPubkeyInput(v: string): void {
    const key = v.toLowerCase();
    if (PUBKEY_RE.test(key)) {
      this.suggestions = [];
      this.selectNode(key);
    } else {
      if (this.pubkey) { this.clearNode(); }
      this.search$.next(v);
    }
  }

  pick(node: { public_key: string, alias: string }): void {
    this.form.get('pubkeyInput').setValue(node.public_key);
  }

  clearNode(): void {
    this.pubkey = '';
    this.alias = '';
    this.existing = null;
    this.challenge = null;
    this.signature = '';
    this.error = '';
    this.cd.markForCheck();
  }

  selectNode(key: string): void {
    this.pubkey = key;
    this.error = '';
    this.success = '';
    this.challenge = null;
    this.signature = '';
    this.api.lightningSearch$(key).pipe(take(1), catchError(() => of({ nodes: [] }))).subscribe((r: any) => {
      this.alias = (r?.nodes || []).find((n) => n.public_key === key)?.alias || '';
      this.cd.markForCheck();
    });
    this.directory.getEntry$(key).pipe(take(1)).subscribe((e) => {
      this.existing = e;
      this.fill(e);
      this.cd.markForCheck();
    });
  }

  private fill(e: DirectoryEntry | null): void {
    const contacts = {};
    for (const k of this.contactKinds) { contacts[k] = e?.contacts?.[k] || ''; }
    this.form.patchValue({
      name: e?.name || '',
      description: e?.description || '',
      tags: (e?.tags || []).join(', '),
      min_channel_size: e?.min_channel_size ? String(e.min_channel_size) : '',
      contacts,
    }, { emitEvent: false });
  }

  private entryFromForm(): DirectoryEntry {
    const v = this.form.value;
    const contacts = {};
    for (const k of this.contactKinds) {
      const c = (v.contacts[k] || '').trim();
      if (c) { contacts[k] = c; }
    }
    const entry: DirectoryEntry = {};
    if (v.name.trim()) { entry.name = v.name.trim(); }
    if (v.description.trim()) { entry.description = v.description.trim(); }
    const tags = v.tags.split(',').map((t) => t.trim()).filter((t) => t);
    if (tags.length) { entry.tags = tags; }
    if (Object.keys(contacts).length) { entry.contacts = contacts; }
    const mcs = String(v.min_channel_size || '').replace(/[\s.,_]/g, '');
    if (mcs) { entry.min_channel_size = /^\d+$/.test(mcs) ? Number(mcs) : (mcs as any); }
    return entry;
  }

  getText(action: 'publish' | 'delete'): void {
    if (!this.pubkey || this.busy) { return; }
    this.busy = true;
    this.error = '';
    this.success = '';
    this.signature = '';
    this.directory.getChallenge$(this.pubkey, action, action === 'publish' ? this.entryFromForm() : undefined).subscribe({
      next: (c) => {
        this.challenge = c;
        this.busy = false;
        this.cd.markForCheck();
      },
      error: (e) => this.fail(e),
    });
  }

  onSignature(v: string): void {
    this.signature = (v || '').trim();
  }

  send(): void {
    if (!this.challenge || !this.signature || this.busy) { return; }
    this.busy = true;
    this.error = '';
    const done = (msg: string) => {
      this.busy = false;
      this.challenge = null;
      this.signature = '';
      this.success = msg;
      this.directory.refresh();
      this.directory.getEntry$(this.pubkey).pipe(take(2)).subscribe((e) => { this.existing = e; this.cd.markForCheck(); });
      this.cd.markForCheck();
    };
    if (this.challenge.action === 'delete') {
      this.directory.delete$(this.pubkey, this.challenge.text, this.signature).subscribe({
        next: () => { this.fill(null); done($localize`:@@lightning.directory-edit-deleted:Your card was deleted.`); },
        error: (e) => this.fail(e),
      });
    } else {
      this.directory.submit$(this.pubkey, this.challenge.text, this.signature, this.entryFromForm()).subscribe({
        next: (r) => done(r.result === 'unchanged'
          ? $localize`:@@lightning.directory-edit-unchanged:Signature verified. Nothing changed in your card.`
          : $localize`:@@lightning.directory-edit-published:Done! Your card is published.`),
        error: (e) => this.fail(e),
      });
    }
  }

  private fail(e: any): void {
    this.busy = false;
    const b = e?.error || {};
    const known: { [code: string]: string } = {
      rate_limited: $localize`:@@lightning.directory-err-rate:Too many attempts. Wait a few minutes and try again.`,
      challenge_unknown: $localize`:@@lightning.directory-err-unknown:That text was not issued for this node. Get a new text to sign.`,
      challenge_used: $localize`:@@lightning.directory-err-used:That text was already used. Get a new text to sign.`,
      challenge_expired: $localize`:@@lightning.directory-err-expired:That text expired (they last 10 minutes). Get a new text to sign.`,
      challenge_mismatch: $localize`:@@lightning.directory-err-mismatch:The card changed after you got the text. Get a new text to sign.`,
      bad_signature_format: $localize`:@@lightning.directory-err-format:That does not look like a node signature. Paste the "signature" value (zbase32) your node gave you.`,
      signature_invalid: $localize`:@@lightning.directory-err-invalid:The signature does not match this node and text. Sign exactly the text shown, with this node.`,
      node_not_in_graph: $localize`:@@lightning.directory-err-graph:The signature is from this node, but the node is not in the XBT Lightning graph yet. Open a public channel and wait until it is announced.`,
      not_listed: $localize`:@@lightning.directory-err-not-listed:This node has no card to delete.`,
      lnd_unavailable: $localize`:@@lightning.directory-err-lnd:The signature check is unavailable right now. Try again later.`,
      bad_pubkey: $localize`:@@lightning.directory-err-pubkey:The node public key must be 66 hex characters starting with 02 or 03.`,
    };
    if (b.error === 'bad_entry') {
      const label = this.fieldLabels[b.field] || this.contactLabels[b.field] || b.field;
      this.error = $localize`:@@lightning.directory-err-field:Check this field:` + ` ${label} (${b.reason})`;
    } else {
      this.error = known[b.error] || b.message || $localize`:@@lightning.directory-err-generic:Something went wrong. Try again in a while.`;
    }
    this.cd.markForCheck();
  }

  lndCommand(): string { return `lncli signmessage "${this.challenge?.text}"`; }
  clnCommand(): string { return `lightning-cli signmessage "${this.challenge?.text}"`; }
}
