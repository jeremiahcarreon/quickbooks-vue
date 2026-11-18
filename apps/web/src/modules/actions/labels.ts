/** What each SDK action does, for the actions screen. */
export const ACTION_HELP: Record<string, string> = {
  ListMergeRq:
    'Merge one list record into another (accounts, classes, customers, vendors, items). The merged-from record is removed.',
  ClearedStatusModRq: 'Mark a transaction, or one of its lines, Cleared, Not cleared or Pending.',
  SpecialAccountAddRq:
    'Create one of the special accounts QuickBooks manages itself (Undeposited Funds, Opening Balance Equity, ...).',
  SpecialItemAddRq:
    'Create a special item QuickBooks manages itself (finance charge, reimbursable expense group or subtotal).',
  TxnDisplayAddRq: 'Open a new transaction form in QuickBooks Desktop on the QuickBooks machine.',
  TxnDisplayModRq: 'Open an existing transaction in QuickBooks Desktop on the QuickBooks machine.',
  ListDisplayAddRq: 'Open a new list record form in QuickBooks Desktop on the QuickBooks machine.',
  ListDisplayModRq: 'Open an existing list record in QuickBooks Desktop on the QuickBooks machine.',
  DataExtDelRq: 'Delete the value of a custom field (data extension) on a record.',
  DataExtDefDelRq: 'Delete a custom field definition (data extension definition).',
  AlertDelRq: 'Delete an alert an application created.',
  SubscriptionDelRq: 'Remove an event subscription of an integrated application.',
  DataEventRecoveryInfoDelRq: 'Clear the event-recovery information of a subscriber.',
  QBCommandExecRq:
    'Run a QuickBooks command (backup, report export, ...) on the QuickBooks machine.',
  TransactionQueryRq: 'Search transactions of every type at once.',
  ListDeletedQueryRq: 'List records deleted from a list.',
  TxnDeletedQueryRq: 'List transactions deleted from QuickBooks.',
};
