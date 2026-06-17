// Minimal Microsoft Graph resource shapes used by the migration engines.

export interface GraphUser {
  id: string;
  userPrincipalName: string;
  displayName?: string;
  mail?: string;
  accountEnabled?: boolean;
  assignedLicenses?: { skuId: string }[];
  usageLocation?: string;
  /** SMTP/other proxy addresses (e.g. "SMTP:user@tenant.onmicrosoft.com"). */
  proxyAddresses?: string[];
}

export interface MailFolder {
  id: string;
  displayName: string;
  parentFolderId?: string;
  childFolderCount: number;
  totalItemCount: number;
  unreadItemCount?: number;
}

export interface Recipient {
  emailAddress?: { name?: string; address?: string };
}

export interface GraphMessage {
  id: string;
  subject?: string;
  body?: { contentType?: string; content?: string };
  from?: Recipient;
  sender?: Recipient;
  toRecipients?: Recipient[];
  ccRecipients?: Recipient[];
  bccRecipients?: Recipient[];
  replyTo?: Recipient[];
  receivedDateTime?: string;
  sentDateTime?: string;
  isRead?: boolean;
  isDraft?: boolean;
  importance?: string;
  categories?: string[];
  internetMessageId?: string;
  hasAttachments?: boolean;
  flag?: { flagStatus?: string };
  '@removed'?: { reason?: string };
}

export interface GraphAttachment {
  id: string;
  '@odata.type'?: string;
  name?: string;
  contentType?: string;
  size?: number;
  isInline?: boolean;
  contentBytes?: string; // fileAttachment
  contentId?: string;
}

export interface GraphCalendar {
  id: string;
  name?: string;
  isDefaultCalendar?: boolean;
  canEdit?: boolean;
}

export interface GraphEvent {
  id: string;
  subject?: string;
  body?: { contentType?: string; content?: string };
  bodyPreview?: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  location?: { displayName?: string };
  locations?: unknown[];
  attendees?: { emailAddress?: { name?: string; address?: string }; type?: string }[];
  organizer?: Recipient;
  recurrence?: unknown;
  isAllDay?: boolean;
  isCancelled?: boolean;
  sensitivity?: string;
  showAs?: string;
  importance?: string;
  categories?: string[];
  reminderMinutesBeforeStart?: number;
  isReminderOn?: boolean;
  type?: 'singleInstance' | 'occurrence' | 'exception' | 'seriesMaster';
}

export interface GraphContactFolder {
  id: string;
  displayName?: string;
  parentFolderId?: string;
}

export interface GraphContact {
  id: string;
  displayName?: string;
  givenName?: string;
  middleName?: string;
  surname?: string;
  nickName?: string;
  title?: string;
  jobTitle?: string;
  companyName?: string;
  department?: string;
  officeLocation?: string;
  emailAddresses?: { name?: string; address?: string }[];
  businessPhones?: string[];
  homePhones?: string[];
  mobilePhone?: string;
  businessAddress?: unknown;
  homeAddress?: unknown;
  otherAddress?: unknown;
  birthday?: string;
  personalNotes?: string;
  categories?: string[];
  imAddresses?: string[];
  fileAs?: string;
}

export interface TodoTaskList {
  id: string;
  displayName?: string;
  wellknownListName?: string;
}

export interface TodoTask {
  id: string;
  title?: string;
  status?: string;
  importance?: string;
  body?: { content?: string; contentType?: string };
  dueDateTime?: unknown;
  startDateTime?: unknown;
  completedDateTime?: unknown;
  reminderDateTime?: unknown;
  isReminderOn?: boolean;
  recurrence?: unknown;
  categories?: string[];
  checklistItems?: { displayName?: string; isChecked?: boolean }[];
}

export interface GraphDrive {
  id: string;
  driveType?: string;
  quota?: { total?: number; used?: number; remaining?: number };
}

export interface DriveItem {
  id: string;
  name?: string;
  size?: number;
  cTag?: string;
  eTag?: string;
  file?: { mimeType?: string; hashes?: unknown };
  folder?: { childCount?: number };
  deleted?: { state?: string };
  root?: unknown;
  parentReference?: { driveId?: string; id?: string; path?: string };
  fileSystemInfo?: { createdDateTime?: string; lastModifiedDateTime?: string };
  '@microsoft.graph.downloadUrl'?: string;
}

export interface MessageRule {
  id: string;
  displayName?: string;
  sequence?: number;
  isEnabled?: boolean;
  conditions?: Record<string, unknown>;
  exceptions?: Record<string, unknown>;
  actions?: Record<string, unknown> & { moveToFolder?: string; copyToFolder?: string };
}

export interface OutlookCategory {
  id?: string;
  displayName?: string;
  color?: string;
}

export interface MailboxSettings {
  automaticRepliesSetting?: unknown;
  timeZone?: string;
  language?: { locale?: string };
  workingHours?: unknown;
  dateFormat?: string;
  timeFormat?: string;
}

export interface SubscribedSku {
  skuId: string;
  skuPartNumber?: string;
  consumedUnits?: number;
  prepaidUnits?: { enabled?: number };
}

export interface Organization {
  id: string;
  displayName?: string;
  verifiedDomains?: { name?: string; isDefault?: boolean }[];
}

export interface UploadSession {
  uploadUrl: string;
  expirationDateTime?: string;
  nextExpectedRanges?: string[];
}
