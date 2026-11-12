# Refund Approval Runbook

Handle customer refund requests for the support team so every refund is checked the same way.

## Before you start

- Access to the billing dashboard
- The customer's order number

## Steps

1. Look up the order in the billing dashboard and confirm the purchase date.
2. Check the refund window: 30 days for monthly plans, 14 days for annual plans.
3. If the amount is over $200, request approval from the finance lead in #finance-approvals.
4. Issue the refund from the billing dashboard and copy the refund ID.
5. Reply to the customer with the refund ID and the 5 business day timeline.

## Rules

- Never refund to a different card than the original payment. Fraud risk.
- Always log the refund ID in the ticket. Finance audits depend on it.

## Escalate

Stop and escalate to the support lead when the customer mentions a chargeback or legal action.

## Output

A short reply to the customer plus a one-line internal note with the refund ID.
