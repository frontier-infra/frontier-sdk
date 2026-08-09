export type AuditShape = 'auto' | 'machine' | 'orchestrator';
export type AuditVerifierIndependence = 'same_principal' | 'separate_principal' | 'third_party';
export type AuditLiveCheckStatus = 'NOT_RUN';
export type AuditNetworkActions = 'NOT_RUN';
export type AuditVerificationStatus = 'PASS';

export interface AuditRunOptions {
  target?: string;
  outDir?: string;
  name?: string;
  shape?: AuditShape;
  signKeyPath?: string;
  didJsonPath?: string;
  verifierIndependence?: AuditVerifierIndependence;
  subject?: string;
  principal?: string;
}

export interface AuditVerifyOptions {
  evidenceJsonPath?: string;
  aarPath?: string;
  didJsonPath: string;
}

export interface AuditGeneratedFileLock {
  generated_sha256: string;
  [key: string]: unknown;
}

export interface AuditSnapshotLock {
  files?: Record<string, AuditGeneratedFileLock>;
  [key: string]: unknown;
}

export interface AuditPackageMetadata {
  audit_package_version: string;
  node: string;
  platform: string;
  snapshot_lock_sha256: string;
  snapshot_lock: AuditSnapshotLock;
}

export interface AuditPreflightBinding {
  branch: string | null;
  commit: string;
  dirty: boolean;
  git_root: string;
  staged_diff_sha256: string;
  status_entries: string[];
  status_sha256: string;
  tracked_diff_sha256: string;
  untracked_files: Array<{
    path: string;
    bytes: number;
    sha256: string | null;
  }>;
}

export interface AuditTargetBinding {
  name: string;
  path: string;
  subject: string;
  subject_source: 'operator_supplied' | 'derived_local_repository_id';
  output_inside_target: boolean;
}

export interface AuditPacketInfo {
  id: string;
  issued_at: string;
  command: 'frontier-audit run';
  network_actions: AuditNetworkActions;
}

export interface AuditLiveCheck {
  id: string;
  title: string;
  status: AuditLiveCheckStatus;
  reason: string;
}

export interface AuditEvidencePacket {
  schema_version: typeof AUDIT_PACKET_SCHEMA_VERSION;
  audit: AuditPacketInfo;
  target: AuditTargetBinding;
  package: AuditPackageMetadata;
  preflight: AuditPreflightBinding;
  static_score: Record<string, unknown>;
  live_checks: AuditLiveCheck[];
}

export interface AuditSigningResult {
  aar_path: string;
  did_json_path: string;
  signed_payload_path: string;
  signed_payload_sha256: string;
  verification: {
    status: AuditVerificationStatus;
    output: string;
  };
}

export interface AuditRunResult {
  evidenceJsonPath: string;
  kitJsonPath: string;
  kitMarkdownPath: string;
  markdownPath: string;
  outDir: string;
  packet: AuditEvidencePacket;
  signing: AuditSigningResult | null;
}

export interface AuditVerifyResult {
  aar_path: string;
  did_json_path: string;
  evidence_json_path: string;
  evidence_sha256: string;
  status: AuditVerificationStatus;
  output: string;
}

export const AUDIT_PACKAGE_VERSION: string;
export const AUDIT_PACKET_SCHEMA_VERSION: 'frontier.audit.packet.v1';
export function runAudit(options?: AuditRunOptions): AuditRunResult;
export function verifyAudit(options: AuditVerifyOptions): AuditVerifyResult;
