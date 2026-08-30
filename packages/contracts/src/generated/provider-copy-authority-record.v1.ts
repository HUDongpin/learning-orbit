/* generated; source is JSON Schema */

export interface ProviderCopyAuthorityRecord {
  recordKind: "provider_copy_authority";
  authorityId: string;
  issuerId: string;
  keyId: string;
  providerId: string;
  providerManifestSha256: string;
  lifecycleMode: "no_persistent_copy_attested";
  region: string;
  purpose: string;
  scopeHash: string;
  startsAt: string;
  expiresAt: string;
  recordSha256: string;
}
