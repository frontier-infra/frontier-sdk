# @frontier-infra/governance-react

Accessible, dependency-light React components for Frontier governance surfaces.
React is a peer dependency, and the package ships plain CSS at
`@frontier-infra/governance-react/style.css`.

```jsx
import {
  ApprovalPanel,
  ContractCard,
  OverrideControl,
  ReceiptTimeline,
  RuntimeHealthPanel,
} from '@frontier-infra/governance-react';
import '@frontier-infra/governance-react/style.css';
```

The components render operator-facing state only. They do not independently
verify contracts, grant mutation authority, or produce AAR receipts.

The published module requires the React peer at runtime. Its zero-dependency
test fallback is gated behind `FRONTIER_GOVERNANCE_REACT_TEST_PEER_FALLBACK=1`
and is not intended for consuming applications.

## Components

- `ContractCard` summarizes contract identity, parties, scope, and status.
- `ApprovalPanel` renders a proposal summary and approve/reject controls.
- `ReceiptTimeline` displays hash-chain or evidence receipt summaries.
- `RuntimeHealthPanel` summarizes runtime health and mutation eligibility.
- `OverrideControl` renders a controlled break-glass override control.
