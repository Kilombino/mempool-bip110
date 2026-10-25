import { ChangeDetectionStrategy, ChangeDetectorRef, Component, Input, OnDestroy, OnInit } from '@angular/core';
import { FormBuilder, FormGroup } from '@angular/forms';
import { Subscription } from 'rxjs';
import { take } from 'rxjs/operators';
import { DirectoryEntry, DirectoryLoginText, DirectorySession, LightningDirectoryService } from '@app/lightning/directory/directory.service';

// "Log in with your node": the operator signs a one-time login text with their node key, the
// ln-directory service checks it with our LND (which tells us which node signed), and opens a
// session. While logged in they edit, save or delete their own card, and can log out (here or
// everywhere).
@Component({
  selector: 'app-node-directory-editor',
  templateUrl: './directory-editor.component.html',
  styleUrls: ['./directory.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DirectoryEditorComponent implements OnInit, OnDestroy {
  // Set when coming from a node's "Is this your node?" link.
  @Input() initialPubkey: string;

  form: FormGroup;
  session: DirectorySession | null = null;
  checking = true;
  loginText: DirectoryLoginText | null = null;
  signature = '';
  busy = false;
  confirmDelete = false;
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

  private subs: Subscription[] = [];

  constructor(
    private fb: FormBuilder,
    private directory: LightningDirectoryService,
    private cd: ChangeDetectorRef,
  ) { }

  ngOnInit(): void {
    const contacts = {};
    for (const k of this.contactKinds) { contacts[k] = ['']; }
    this.form = this.fb.group({
      name: [''],
      description: [''],
      tags: [''],
      min_channel_size: [''],
      contacts: this.fb.group(contacts),
    });
    this.subs.push(this.form.valueChanges.subscribe(() => {
      if (this.success) { this.success = ''; this.cd.markForCheck(); }
    }));
    // Already logged in? (the session cookie is HttpOnly, so ask the server)
    this.directory.me$().subscribe({
      next: (s) => { if (s?.pubkey) { this.setSession(s); } this.checking = false; this.cd.markForCheck(); },
      error: () => { this.checking = false; this.cd.markForCheck(); },
    });
  }

  ngOnDestroy(): void {
    this.subs.forEach((s) => s.unsubscribe());
  }

  get shortPubkey(): string {
    const p = this.session?.pubkey || '';
    return p ? `${p.slice(0, 8)}…${p.slice(-8)}` : '';
  }

  get otherNode(): boolean {
    return !!(this.session && this.initialPubkey && this.initialPubkey !== this.session.pubkey);
  }

  private setSession(s: DirectorySession | null): void {
    this.session = s;
    this.loginText = null;
    this.signature = '';
    this.confirmDelete = false;
    this.fill(s?.entry || null);
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

  private start(): boolean {
    if (this.busy) { return false; }
    this.busy = true;
    this.error = '';
    this.success = '';
    return true;
  }

  startLogin(): void {
    if (!this.start()) { return; }
    this.signature = '';
    this.directory.loginText$().subscribe({
      next: (t) => { this.loginText = t; this.busy = false; this.cd.markForCheck(); },
      error: (e) => this.fail(e),
    });
  }

  onSignature(v: string): void {
    this.signature = (v || '').trim();
  }

  login(): void {
    if (!this.loginText || !this.signature || !this.start()) { return; }
    this.directory.login$(this.loginText.text, this.signature).subscribe({
      next: (s) => { this.setSession(s); this.busy = false; this.cd.markForCheck(); },
      error: (e) => this.fail(e),
    });
  }

  save(): void {
    if (!this.session || !this.start()) { return; }
    this.directory.saveCard$(this.session.csrf, this.entryFromForm()).subscribe({
      next: (r) => {
        this.busy = false;
        this.session = { ...this.session, entry: r.entry };
        this.fill(r.entry);
        this.success = r.result === 'unchanged'
          ? $localize`:@@lightning.directory-edit-unchanged-login:Nothing to change: your card is already like this.`
          : $localize`:@@lightning.directory-edit-published:Done! Your card is published.`;
        this.directory.refresh();
        this.cd.markForCheck();
      },
      error: (e) => this.fail(e),
    });
  }

  deleteCard(): void {
    if (!this.session) { return; }
    if (!this.confirmDelete) { this.confirmDelete = true; return; }
    if (!this.start()) { return; }
    this.directory.deleteCard$(this.session.csrf).subscribe({
      next: () => {
        this.busy = false;
        this.confirmDelete = false;
        this.session = { ...this.session, entry: null };
        this.fill(null);
        this.success = $localize`:@@lightning.directory-edit-deleted:Your card was deleted.`;
        this.directory.refresh();
        this.cd.markForCheck();
      },
      error: (e) => this.fail(e),
    });
  }

  logout(everywhere = false): void {
    if (!this.session || !this.start()) { return; }
    this.directory.logout$(this.session.csrf, everywhere).pipe(take(1)).subscribe({
      next: () => {
        this.busy = false;
        this.setSession(null);
        this.success = everywhere
          ? $localize`:@@lightning.directory-login-out-all-done:Logged out on every device.`
          : $localize`:@@lightning.directory-login-out-done:Logged out.`;
        this.cd.markForCheck();
      },
      error: (e) => this.fail(e),
    });
  }

  private fail(e: any): void {
    this.busy = false;
    const b = e?.error || {};
    const known: { [code: string]: string } = {
      rate_limited: $localize`:@@lightning.directory-err-rate:Too many attempts. Wait a few minutes and try again.`,
      challenge_unknown: $localize`:@@lightning.directory-err-login-unknown:That login text was not issued here. Ask for a new one.`,
      challenge_used: $localize`:@@lightning.directory-err-login-used:That login text was already used. Ask for a new one.`,
      challenge_expired: $localize`:@@lightning.directory-err-login-expired:That login text expired (they last 10 minutes). Ask for a new one.`,
      bad_signature_format: $localize`:@@lightning.directory-err-format:That does not look like a node signature. Paste the "signature" value (zbase32) your node gave you.`,
      node_not_in_graph: $localize`:@@lightning.directory-err-login-graph:That signature does not belong to any node of the BLAKE2b Lightning graph. Sign exactly the text shown. If you did, your node is not announced yet: open a public channel and wait.`,
      not_listed: $localize`:@@lightning.directory-err-not-listed:This node has no card to delete.`,
      lnd_unavailable: $localize`:@@lightning.directory-err-lnd:The signature check is unavailable right now. Try again later.`,
      not_logged_in: $localize`:@@lightning.directory-err-session:Your session expired. Log in again.`,
      bad_csrf: $localize`:@@lightning.directory-err-csrf:The page is out of date. Reload it and try again.`,
      bad_origin: $localize`:@@lightning.directory-err-csrf:The page is out of date. Reload it and try again.`,
    };
    if (b.error === 'not_logged_in') { this.setSession(null); }
    if (b.error === 'bad_entry') {
      const label = this.fieldLabels[b.field] || this.contactLabels[b.field] || b.field;
      this.error = $localize`:@@lightning.directory-err-field:Check this field:` + ` ${label} (${b.reason})`;
    } else {
      this.error = known[b.error] || b.message || $localize`:@@lightning.directory-err-generic:Something went wrong. Try again in a while.`;
    }
    this.cd.markForCheck();
  }

  lndCommand(): string { return `lncli signmessage "${this.loginText?.text}"`; }
  clnCommand(): string { return `lightning-cli signmessage "${this.loginText?.text}"`; }
}
