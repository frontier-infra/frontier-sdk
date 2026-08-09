import type { ReactElement, ReactNode } from 'react';

export type GovernanceStatus = 'pass' | 'ready' | 'pending' | 'approved' | 'rejected' | 'degraded' | 'proposal-only' | 'blocked' | 'halted' | 'invalid' | string;

export interface ContractSummary {
  id?: string;
  goal_id?: string;
  goalId?: string;
  status?: GovernanceStatus;
  proposed_by?: string;
  proposedBy?: string;
  verifier_id?: string;
  verifierId?: string;
  ratified_by?: string | null;
  ratifiedBy?: string | null;
  scope?: string;
  expires_at?: string;
  expiresAt?: string;
  effect_allowlist?: Array<{ effect?: string; scope?: string }>;
  effectAllowlist?: Array<{ effect?: string; scope?: string }>;
}

export interface ContractCardProps {
  id?: string;
  contract?: ContractSummary | null;
  title?: string;
  className?: string;
}

export interface ApprovalRecord {
  id?: string;
  actor?: string;
  status?: GovernanceStatus;
  at?: string;
  note?: string;
}

export interface ProposalSummary {
  id?: string;
  effect?: string;
  scope?: string;
  summary?: string;
}

export interface ApprovalPanelProps {
  id?: string;
  title?: string;
  proposal?: ProposalSummary | null;
  approvals?: ApprovalRecord[];
  status?: GovernanceStatus;
  approveLabel?: string;
  rejectLabel?: string;
  disabled?: boolean;
  onApprove?: () => void;
  onReject?: () => void;
  className?: string;
}

export interface ReceiptSummary {
  id?: string;
  receipt_hash?: string;
  receiptHash?: string;
  event_hash?: string;
  eventHash?: string;
  at?: string;
  status?: GovernanceStatus;
  summary?: string;
  verifier_id?: string;
  verifierId?: string;
}

export interface ReceiptTimelineProps {
  id?: string;
  receipts?: ReceiptSummary[];
  title?: string;
  emptyLabel?: ReactNode;
  className?: string;
}

export interface RuntimeHealthLayerResult {
  status?: GovernanceStatus;
  failures?: string[];
}

export interface RuntimeHealthReport {
  status?: GovernanceStatus;
  can_mutate?: boolean;
  canMutate?: boolean;
  deployment_id?: string | null;
  deploymentId?: string | null;
  checked_at?: string | null;
  checkedAt?: string | null;
  layers?: Record<string, RuntimeHealthLayerResult>;
  blockers?: string[];
  propose_only?: string[];
  proposeOnly?: string[];
  halted?: string[];
  degraded?: string[];
  errors?: string[];
}

export interface RuntimeHealthPanelProps {
  id?: string;
  report?: RuntimeHealthReport | null;
  title?: string;
  className?: string;
}

export interface OverrideControlProps {
  id?: string;
  active?: boolean;
  reason?: string;
  disabled?: boolean;
  enableLabel?: string;
  disableLabel?: string;
  acknowledgement?: boolean;
  onAcknowledgementChange?: (checked: boolean) => void;
  onEnable?: () => void;
  onDisable?: () => void;
  className?: string;
}

export function ContractCard(props: ContractCardProps): ReactElement;
export function ApprovalPanel(props: ApprovalPanelProps): ReactElement;
export function ReceiptTimeline(props: ReceiptTimelineProps): ReactElement;
export function RuntimeHealthPanel(props: RuntimeHealthPanelProps): ReactElement;
export function OverrideControl(props: OverrideControlProps): ReactElement;
