import { ChangeDetectionStrategy, Component, Input, OnChanges } from '@angular/core';
import { Observable } from 'rxjs';
import { DirectoryEntry, LightningDirectoryService, contactLink } from '@app/lightning/directory/directory.service';

@Component({
  selector: 'app-node-directory-card',
  templateUrl: './node-directory-card.component.html',
  styleUrls: ['./directory.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NodeDirectoryCardComponent implements OnChanges {
  @Input() publicKey: string;
  entry$: Observable<DirectoryEntry | null>;
  contactLink = contactLink;
  contactKinds = ['telegram', 'nostr', 'email', 'website', 'lightning_address', 'x', 'discord', 'simplex'];
  contactLabels: { [k: string]: string } = {
    telegram: 'Telegram', nostr: 'Nostr', email: 'Email', website: 'Web', lightning_address: 'Lightning address',
    x: 'X', discord: 'Discord', simplex: 'SimpleX',
  };

  constructor(private directory: LightningDirectoryService) { }

  ngOnChanges(): void {
    this.entry$ = this.directory.getEntry$(this.publicKey);
  }
}
