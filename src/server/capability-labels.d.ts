export declare const MERIDIAN_CAPABILITIES: readonly [
  readonly ['meridian-sign-on', 'Sign on'],
  readonly ['meridian-member-inquiry', 'Member inquiry'],
  readonly ['meridian-member-record', 'Member record'],
  readonly ['meridian-funds-transfer', 'Funds transfer'],
  readonly ['meridian-open-share', 'Open share'],
  readonly ['meridian-update-member', 'Update contact'],
  readonly ['meridian-place-hold', 'Supervisor hold'],
];
export type MeridianCapabilityId = (typeof MERIDIAN_CAPABILITIES)[number][0];
export declare const MERIDIAN_CAPABILITY_LABELS: ReadonlyMap<string, string>;
