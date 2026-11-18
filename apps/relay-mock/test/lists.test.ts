import { describe, expect, it } from 'vitest';
import { ok, ref, ret, testEngine } from './helpers.js';

describe('list objects', () => {
  it('adds with QuickBooks-style ids, times and edit sequence', () => {
    const t = testEngine('2026-03-01T15:00:00Z');
    const c = ret(t.rq('CustomerAddRq', { Name: 'Acme Heating', Phone: '555-0101' }));
    expect(c.ListID).toMatch(/^80000001-\d{10}$/);
    expect(c.ListID).toBe(`80000001-${Math.floor(Date.parse('2026-03-01T15:00:00Z') / 1000)}`);
    expect(c.EditSequence).toMatch(/^\d{10}$/);
    expect(c.TimeCreated).toBe(c.TimeModified);
    expect(c.TimeCreated).toMatch(/^2026-03-0[12]T\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
    expect(c).toMatchObject({
      Name: 'Acme Heating',
      FullName: 'Acme Heating',
      IsActive: 'true',
      Sublevel: '0',
      Phone: '555-0101',
      Balance: '0.00',
      TotalBalance: '0.00',
    });
    const c2 = ret(t.rq('CustomerAddRq', { Name: 'Beta' }));
    expect(c2.ListID).toMatch(/^80000002-/);
  });

  it('rejects duplicate names (3100), case-insensitively and across the name list', () => {
    const t = testEngine();
    ok(t.rq('CustomerAddRq', { Name: 'Acme' }));
    const dup = t.rq('CustomerAddRq', { Name: 'ACME' });
    expect(dup.statusCode).toBe(3100);
    expect(dup.statusSeverity).toBe('Error');
    expect(dup.statusMessage).toBe('The name "ACME" of the list element is already in use.');
    // Customers, vendors, employees and other names share one name space.
    expect(t.rq('VendorAddRq', { Name: 'Acme' }).statusCode).toBe(3100);
    // Items share one name space across item types.
    ok(t.rq('ItemServiceAddRq', { Name: 'Labor', SalesOrPurchase: { Price: 10 } }));
    expect(
      t.rq('ItemOtherChargeAddRq', { Name: 'labor', SalesOrPurchase: { Price: 1 } }).statusCode,
    ).toBe(3100);
    // Different lists are independent.
    ok(t.rq('ClassAddRq', { Name: 'Acme' }));
  });

  it('builds FullName / Sublevel for hierarchies and cascades renames', () => {
    const t = testEngine();
    const parent = ret(t.rq('CustomerAddRq', { Name: 'Maple Apts' }));
    const job = ret(t.rq('CustomerAddRq', { Name: 'Bldg A', ParentRef: ref('Maple Apts') }));
    expect(job).toMatchObject({
      FullName: 'Maple Apts:Bldg A',
      Sublevel: '1',
      ParentRef: { ListID: parent.ListID, FullName: 'Maple Apts' },
    });
    const unit = ret(
      t.rq('CustomerAddRq', { Name: 'Unit 1', ParentRef: ref('Maple Apts:Bldg A') }),
    );
    expect(unit).toMatchObject({ FullName: 'Maple Apts:Bldg A:Unit 1', Sublevel: '2' });
    // Same leaf name under different parents is fine.
    ok(t.rq('CustomerAddRq', { Name: 'Bldg A' }));
    t.advance(5000);
    const renamed = ret(
      t.rq('CustomerModRq', {
        ListID: parent.ListID,
        EditSequence: parent.EditSequence,
        Name: 'Maple Street Apts',
      }),
    );
    expect(renamed.FullName).toBe('Maple Street Apts');
    const q = t.rq('CustomerQueryRq', { ListID: [job.ListID, unit.ListID] });
    expect(q.rets.map((r) => r.FullName)).toEqual([
      'Maple Street Apts:Bldg A',
      'Maple Street Apts:Bldg A:Unit 1',
    ]);
    expect(q.rets[0]!.ParentRef).toEqual({ ListID: parent.ListID, FullName: 'Maple Street Apts' });
    // Renamed children get a new TimeModified so incremental sync sees them.
    expect(q.rets[0]!.TimeModified).not.toBe(job.TimeModified);
  });

  it('checks EditSequence on Mod (3200) and increments it', () => {
    const t = testEngine();
    const c = ret(t.rq('CustomerAddRq', { Name: 'Acme' }));
    t.advance(1000);
    const m1 = ret(
      t.rq('CustomerModRq', { ListID: c.ListID, EditSequence: c.EditSequence, Phone: '555-0199' }),
    );
    expect(Number(m1.EditSequence)).toBeGreaterThan(Number(c.EditSequence));
    expect(m1.Phone).toBe('555-0199');
    expect(m1.Name).toBe('Acme');
    const stale = t.rq('CustomerModRq', {
      ListID: c.ListID,
      EditSequence: c.EditSequence,
      Phone: '555-0100',
    });
    expect(stale.statusCode).toBe(3200);
    expect(stale.statusMessage).toContain(
      `edit sequence "${String(c.EditSequence)}" is out-of-date`,
    );
    // A Mod within the same second still gets a new edit sequence.
    const m2 = ret(
      t.rq('CustomerModRq', { ListID: c.ListID, EditSequence: m1.EditSequence, Phone: '555-0101' }),
    );
    expect(Number(m2.EditSequence)).toBeGreaterThan(Number(m1.EditSequence));
    const missing = t.rq('CustomerModRq', {
      ListID: '80000099-1700000000',
      EditSequence: '1',
      Phone: '1',
    });
    expect(missing.statusCode).toBe(3120);
    expect(missing.statusMessage).toBe(
      'Object "80000099-1700000000" specified in the request cannot be found.',
    );
  });

  it('rejects references to missing objects (3140)', () => {
    const t = testEngine();
    const r = t.rq('CustomerAddRq', { Name: 'Acme', TermsRef: ref('Net 99') });
    expect(r.statusCode).toBe(3140);
    expect(r.statusMessage).toContain('invalid reference to QuickBooks Terms "Net 99"');
    expect(t.rq('CustomerQueryRq', { FullName: 'Acme' }).statusCode).toBe(500);
  });

  it('filters queries: ActiveStatus, names, modified dates, MaxReturned, IncludeRetElement', () => {
    const t = testEngine('2026-01-01T12:00:00Z');
    const a = ret(t.rq('VendorAddRq', { Name: 'Alpha Supply' }));
    t.advance(3600_000);
    ret(t.rq('VendorAddRq', { Name: 'Beta Parts', IsActive: false }));
    t.advance(3600_000);
    ret(t.rq('VendorAddRq', { Name: 'Gamma Electric' }));
    expect(t.rq('VendorQueryRq', {}).rets.map((r) => r.Name)).toEqual([
      'Alpha Supply',
      'Gamma Electric',
    ]);
    expect(t.rq('VendorQueryRq', { ActiveStatus: 'All' }).rets).toHaveLength(3);
    expect(t.rq('VendorQueryRq', { ActiveStatus: 'InactiveOnly' }).rets.map((r) => r.Name)).toEqual(
      ['Beta Parts'],
    );
    expect(
      t
        .rq('VendorQueryRq', { NameFilter: { MatchCriterion: 'StartsWith', Name: 'g' } })
        .rets.map((r) => r.Name),
    ).toEqual(['Gamma Electric']);
    expect(
      t.rq('VendorQueryRq', {
        NameRangeFilter: { FromName: 'b', ToName: 'h' },
        ActiveStatus: 'All',
      }).rets,
    ).toHaveLength(2);
    expect(
      t
        .rq('VendorQueryRq', {
          FromModifiedDate: '2026-01-01T13:00:00Z'.replace('Z', '+00:00'),
          ActiveStatus: 'All',
        })
        .rets.map((r) => r.Name),
    ).toEqual(['Beta Parts', 'Gamma Electric']);
    expect(t.rq('VendorQueryRq', { MaxReturned: 1 }).rets).toHaveLength(1);
    const slim = t.rq('VendorQueryRq', {
      ListID: a.ListID,
      IncludeRetElement: ['ListID', 'EditSequence'],
    });
    expect(slim.rets).toEqual([{ ListID: a.ListID, EditSequence: a.EditSequence }]);
    const none = t.rq('VendorQueryRq', { NameFilter: { MatchCriterion: 'Contains', Name: 'zzz' } });
    expect(none.statusCode).toBe(1);
    expect(none.statusSeverity).toBe('Info');
    expect(none.statusMessage).toBe('A query request did not find a matching object in QuickBooks');
    const partial = t.rq('VendorQueryRq', { ListID: [a.ListID, '80000077-1'] });
    expect(partial.statusCode).toBe(500);
    expect(partial.statusSeverity).toBe('Warn');
    expect(partial.rets).toHaveLength(1);
  });

  it('pages with iterators', () => {
    const t = testEngine();
    for (let i = 0; i < 7; i++) ok(t.rq('ClassAddRq', { Name: `Class ${i}` }));
    expect(t.rq('ClassQueryRq', { MaxReturned: 3 }).rets).toHaveLength(3);
    expect(t.rq('CustomerQueryRq', {}).statusCode).toBe(1);
    for (let i = 0; i < 7; i++) ok(t.rq('CustomerAddRq', { Name: `Cust ${i}` }));
    const p1 = t.rq('CustomerQueryRq', { MaxReturned: 3 }, { iterator: 'Start' });
    expect(p1.rets.map((r) => r.Name)).toEqual(['Cust 0', 'Cust 1', 'Cust 2']);
    expect(p1.iteratorRemainingCount).toBe(4);
    expect(p1.iteratorID).toMatch(/^\{[0-9A-F-]{36}\}$/);
    const p2 = t.rq(
      'CustomerQueryRq',
      { MaxReturned: 3 },
      { iterator: 'Continue', iteratorID: p1.iteratorID },
    );
    expect(p2.rets.map((r) => r.Name)).toEqual(['Cust 3', 'Cust 4', 'Cust 5']);
    expect(p2.iteratorRemainingCount).toBe(1);
    const p3 = t.rq(
      'CustomerQueryRq',
      { MaxReturned: 3 },
      { iterator: 'Continue', iteratorID: p1.iteratorID },
    );
    expect(p3.rets.map((r) => r.Name)).toEqual(['Cust 6']);
    expect(p3.iteratorRemainingCount).toBe(0);
    const gone = t.rq(
      'CustomerQueryRq',
      { MaxReturned: 3 },
      { iterator: 'Continue', iteratorID: p1.iteratorID },
    );
    expect(gone.statusCode).toBe(3000);
    const p4 = t.rq('CustomerQueryRq', { MaxReturned: 2 }, { iterator: 'Start' });
    const stop = t.rq('CustomerQueryRq', {}, { iterator: 'Stop', iteratorID: p4.iteratorID });
    expect(stop.statusCode).toBe(0);
    expect(t.engine.iterators.size).toBe(0);
  });

  it('union queries return every member type', () => {
    const t = testEngine();
    ok(t.rq('ItemServiceAddRq', { Name: 'Labor', SalesOrPurchase: { Price: 100 } }));
    ok(t.rq('ItemNonInventoryAddRq', { Name: 'Furnace', SalesOrPurchase: { Price: 3000 } }));
    ok(t.rq('CustomerAddRq', { Name: 'Acme' }));
    ok(t.rq('VendorAddRq', { Name: 'Supply Co' }));
    ok(t.rq('EmployeeAddRq', { FirstName: 'Ann', LastName: 'Lee' }));
    const items = t.rq('ItemQueryRq', {});
    expect(items.retNames.sort()).toEqual(['ItemNonInventoryRet', 'ItemServiceRet']);
    const names = t.rq('EntityQueryRq', {});
    expect(names.retNames.sort()).toEqual(['CustomerRet', 'EmployeeRet', 'VendorRet']);
    expect(names.rets.find((r) => r.Name === 'Ann Lee')).toBeDefined();
    ok(t.rq('StandardTermsAddRq', { Name: 'Net 30', StdDueDays: 30 }));
    ok(t.rq('DateDrivenTermsAddRq', { Name: 'EOM', DayOfMonthDue: 28 }));
    expect(t.rq('TermsQueryRq', {}).rets).toHaveLength(2);
  });

  it('deletes list objects, logs them for ListDeletedQuery and refuses in-use ones', () => {
    const t = testEngine('2026-02-01T00:00:00Z');
    const cls = ret(t.rq('ClassAddRq', { Name: 'Temp' }));
    const used = ret(t.rq('ClassAddRq', { Name: 'Used' }));
    ok(t.rq('CustomerAddRq', { Name: 'Acme', ClassRef: ref('Used') }));
    t.advance(60_000);
    const del = ok(t.rq('ListDelRq', { ListDelType: 'Class', ListID: cls.ListID }));
    expect(del.body).toMatchObject({ ListDelType: 'Class', ListID: cls.ListID, FullName: 'Temp' });
    expect(t.rq('ClassQueryRq', {}).rets.map((r) => r.Name)).toEqual(['Used']);
    const inUse = t.rq('ListDelRq', { ListDelType: 'Class', ListID: used.ListID });
    expect(inUse.statusCode).toBe(3170);
    expect(t.rq('ListDelRq', { ListDelType: 'Class', ListID: cls.ListID }).statusCode).toBe(3120);
    const deleted = t.rq('ListDeletedQueryRq', { ListDelType: ['Class', 'Customer'] });
    expect(deleted.rets).toEqual([
      {
        ListDelType: 'Class',
        ListID: cls.ListID,
        TimeCreated: cls.TimeCreated,
        TimeDeleted: expect.any(String),
        FullName: 'Temp',
      },
    ]);
    const later = t.rq('ListDeletedQueryRq', {
      ListDelType: 'Class',
      DeletedDateRangeFilter: { FromDeletedDate: '2026-03-01T00:00:00+00:00' },
    });
    expect(later.statusCode).toBe(1);
  });

  it('special accounts are created once', () => {
    const t = testEngine();
    const a = ret(
      t.rq('SpecialAccountAddRq', {
        SpecialAccountAdd: { SpecialAccountType: 'UndepositedFunds' },
      }),
    );
    expect(a).toMatchObject({
      Name: 'Undeposited Funds',
      AccountType: 'OtherCurrentAsset',
      SpecialAccountType: 'UndepositedFunds',
    });
    const b = ret(
      t.rq('SpecialAccountAddRq', {
        SpecialAccountAdd: { SpecialAccountType: 'UndepositedFunds' },
      }),
    );
    expect(b.ListID).toBe(a.ListID);
  });
});
