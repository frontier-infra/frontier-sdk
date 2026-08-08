let ReactModule;
const testFallbackEnabled = typeof process !== 'undefined'
  && process?.env?.FRONTIER_GOVERNANCE_REACT_TEST_PEER_FALLBACK === '1';

if (testFallbackEnabled) {
  let testId = 0;
  ReactModule = {
    createElement(type, props, ...children) {
      return { type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } };
    },
    useId() {
      testId += 1;
      return `test-${testId}`;
    },
  };
} else {
  try {
    ReactModule = await import('react');
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    throw new Error('@frontier-infra/governance-react requires React as a peer dependency. Install react >=18 in the consuming app.');
  }
}

const h = ReactModule.createElement;
const useId = ReactModule.useId;

function cx(...values) {
  return values.filter(Boolean).join(' ');
}

function valueOf(object, snake, camel) {
  return object?.[snake] ?? object?.[camel] ?? null;
}

function label(value, fallback = 'Not available') {
  return value === null || value === undefined || value === '' ? fallback : String(value);
}

function statusClass(status) {
  return `fi-status fi-status--${String(status ?? 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

function stableDomId(value) {
  return String(value).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'frontier-governance';
}

function useComponentId(explicitId, prefix) {
  return stableDomId(explicitId ?? `${prefix}-${useId()}`);
}

function StatusBadge({ status }) {
  return h('span', { className: statusClass(status) }, label(status, 'unknown'));
}

function DetailList({ rows }) {
  return h(
    'dl',
    { className: 'fi-detail-list' },
    rows.flatMap(([term, description]) => [
      h('dt', { key: `${term}-term` }, term),
      h('dd', { key: `${term}-description` }, label(description)),
    ]),
  );
}

export function ContractCard({ id, contract, title = 'Contract', className = '' } = {}) {
  const effectAllowlist = valueOf(contract, 'effect_allowlist', 'effectAllowlist') ?? [];
  const titleId = `${useComponentId(id, 'fi-contract-card')}-title`;
  return h(
    'article',
    { className: cx('fi-card', 'fi-contract-card', className), 'aria-labelledby': titleId },
    h(
      'header',
      { className: 'fi-card-header' },
      h('h2', { id: titleId }, title),
      h(StatusBadge, { status: contract?.status ?? 'pending' }),
    ),
    h(DetailList, {
      rows: [
        ['Contract', contract?.id],
        ['Goal', valueOf(contract, 'goal_id', 'goalId')],
        ['Scope', contract?.scope],
        ['Worker', valueOf(contract, 'proposed_by', 'proposedBy')],
        ['Verifier', valueOf(contract, 'verifier_id', 'verifierId')],
        ['Ratified by', valueOf(contract, 'ratified_by', 'ratifiedBy')],
        ['Expires', valueOf(contract, 'expires_at', 'expiresAt')],
      ],
    }),
    effectAllowlist.length
      ? h(
          'ul',
          { className: 'fi-chip-list', 'aria-label': 'Allowed effects' },
          effectAllowlist.map((entry, index) => h('li', { key: `${entry.effect ?? 'effect'}-${index}` }, `${label(entry.effect)} ${entry.scope ? `(${entry.scope})` : ''}`)),
        )
      : null,
  );
}

export function ApprovalPanel({
  id,
  title = 'Approval',
  proposal,
  approvals = [],
  status = 'pending',
  approveLabel = 'Approve',
  rejectLabel = 'Reject',
  disabled = false,
  onApprove,
  onReject,
  className = '',
} = {}) {
  const titleId = `${useComponentId(id, 'fi-approval-panel')}-title`;
  return h(
    'section',
    { className: cx('fi-card', 'fi-approval-panel', className), 'aria-labelledby': titleId },
    h(
      'header',
      { className: 'fi-card-header' },
      h('h2', { id: titleId }, title),
      h(StatusBadge, { status }),
    ),
    h(DetailList, {
      rows: [
        ['Proposal', proposal?.id],
        ['Effect', proposal?.effect],
        ['Scope', proposal?.scope],
        ['Summary', proposal?.summary],
      ],
    }),
    h(
      'ul',
      { className: 'fi-approval-list', 'aria-label': 'Approval records' },
      approvals.length
        ? approvals.map((approval, index) => h(
            'li',
            { key: approval.id ?? `${approval.actor}-${index}` },
            h('span', null, label(approval.actor, 'Unknown actor')),
            h(StatusBadge, { status: approval.status ?? 'pending' }),
          ))
        : h('li', null, 'No approvals recorded'),
    ),
    h(
      'div',
      { className: 'fi-action-row' },
      h('button', { type: 'button', onClick: onApprove, disabled, className: 'fi-button fi-button--primary' }, approveLabel),
      h('button', { type: 'button', onClick: onReject, disabled, className: 'fi-button fi-button--secondary' }, rejectLabel),
    ),
  );
}

export function ReceiptTimeline({ id, receipts = [], title = 'Receipts', emptyLabel = 'No receipts yet', className = '' } = {}) {
  const titleId = `${useComponentId(id, 'fi-receipt-timeline')}-title`;
  return h(
    'section',
    { className: cx('fi-card', 'fi-receipt-timeline', className), 'aria-labelledby': titleId },
    h('h2', { id: titleId }, title),
    receipts.length
      ? h(
          'ol',
          { className: 'fi-timeline' },
          receipts.map((receipt, index) => {
            const hash = valueOf(receipt, 'receipt_hash', 'receiptHash') ?? valueOf(receipt, 'event_hash', 'eventHash');
            return h(
              'li',
              { key: receipt.id ?? hash ?? index },
              h('div', { className: 'fi-timeline-marker', 'aria-hidden': 'true' }),
              h(
                'div',
                { className: 'fi-timeline-body' },
                h('div', { className: 'fi-timeline-topline' }, h('strong', null, label(receipt.summary, `Receipt ${index + 1}`)), h(StatusBadge, { status: receipt.status ?? 'recorded' })),
                h(DetailList, {
                  rows: [
                    ['Hash', hash],
                    ['Verifier', valueOf(receipt, 'verifier_id', 'verifierId')],
                    ['Observed', receipt.at],
                  ],
                }),
              ),
            );
          }),
        )
      : h('p', { className: 'fi-empty' }, emptyLabel),
  );
}

export function RuntimeHealthPanel({ id, report, title = 'Runtime health', className = '' } = {}) {
  const canMutate = valueOf(report, 'can_mutate', 'canMutate') === true;
  const titleId = `${useComponentId(id, 'fi-runtime-health')}-title`;
  const layers = Object.entries(report?.layers ?? {});
  const issues = [
    ...(report?.halted ?? []),
    ...(report?.blockers ?? []),
    ...(report?.propose_only ?? report?.proposeOnly ?? []),
    ...(report?.degraded ?? []),
    ...(report?.errors ?? []),
  ];
  return h(
    'section',
    { className: cx('fi-card', 'fi-runtime-health', className), 'aria-labelledby': titleId },
    h(
      'header',
      { className: 'fi-card-header' },
      h('h2', { id: titleId }, title),
      h(StatusBadge, { status: report?.status ?? 'unknown' }),
    ),
    h(DetailList, {
      rows: [
        ['Deployment', valueOf(report, 'deployment_id', 'deploymentId')],
        ['Checked', valueOf(report, 'checked_at', 'checkedAt')],
        ['Mutation gate', canMutate ? 'Can mutate' : 'Proposal-only or blocked'],
      ],
    }),
    layers.length
      ? h(
          'ul',
          { className: 'fi-layer-list', 'aria-label': 'Health layers' },
          layers.map(([name, layer]) => h('li', { key: name }, h('span', null, name), h(StatusBadge, { status: layer?.status ?? 'unknown' }))),
        )
      : null,
    issues.length
      ? h('ul', { className: 'fi-issue-list', 'aria-label': 'Health issues' }, issues.map((issue, index) => h('li', { key: `${issue}-${index}` }, issue)))
      : h('p', { className: 'fi-empty' }, 'No runtime issues reported'),
  );
}

export function OverrideControl({
  id,
  active = false,
  reason = '',
  disabled = false,
  enableLabel = 'Enable override',
  disableLabel = 'Clear override',
  acknowledgement = false,
  onAcknowledgementChange,
  onEnable,
  onDisable,
  className = '',
} = {}) {
  const baseId = useComponentId(id, 'fi-override-control');
  const titleId = `${baseId}-title`;
  const acknowledgementId = `${baseId}-acknowledgement`;
  const canEnable = !disabled && (acknowledgement || !onAcknowledgementChange);
  return h(
    'section',
    { className: cx('fi-card', 'fi-override-control', className), 'aria-labelledby': titleId },
    h(
      'header',
      { className: 'fi-card-header' },
      h('h2', { id: titleId }, 'Override'),
      h(StatusBadge, { status: active ? 'active' : 'inactive' }),
    ),
    h('p', null, active ? label(reason, 'Override is active') : 'No operator override is active.'),
    onAcknowledgementChange
      ? h(
          'label',
          { htmlFor: acknowledgementId, className: 'fi-checkbox-row' },
          h('input', {
            id: acknowledgementId,
            type: 'checkbox',
            checked: acknowledgement,
            disabled,
            onChange: (event) => onAcknowledgementChange(event.target.checked),
          }),
          h('span', null, 'I understand this control must be backed by an independent governance path.'),
        )
      : null,
    h(
      'div',
      { className: 'fi-action-row' },
      active
        ? h('button', { type: 'button', onClick: onDisable, disabled, className: 'fi-button fi-button--secondary' }, disableLabel)
        : h('button', { type: 'button', onClick: onEnable, disabled: !canEnable, className: 'fi-button fi-button--danger' }, enableLabel),
    ),
  );
}
