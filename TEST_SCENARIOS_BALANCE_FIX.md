# Balance Calculation Fix - Comprehensive Test Scenarios

## ✅ ALL OPERATIONS FIXED

### Operations Covered:
1. **CREATE Transaction** ✅ Fixed
2. **UPDATE Transaction** ✅ Fixed  
3. **DELETE Transaction** ✅ Fixed

---

## 🧪 Test Scenarios

### Scenario 1: CREATE Expense Transaction (Asset Account)

**Setup:**
- Account: BCA Checking (Asset)
- Initial Balance: Rp 1.000.000

**Actions:**
1. Create expense transaction: Rp 20.000 (warung makan)

**Expected Results:**
- ✅ Balance immediately shows: Rp 980.000 (decreased by 20.000)
- ✅ Transaction appears in list without refresh
- ✅ Async sync completes and confirms balance is still Rp 980.000

**Formula:**
```
entry_amount = +20000 (positive = expense)
flows_factor = -1 (asset account)
balance_change = 20000 * -1 = -20000
new_balance = 1000000 + (-20000) = 980000 ✅
```

---

### Scenario 2: CREATE Income Transaction (Asset Account)

**Setup:**
- Account: BCA Checking (Asset)
- Current Balance: Rp 980.000

**Actions:**
1. Create income transaction: Rp 500.000 (gaji)

**Expected Results:**
- ✅ Balance immediately shows: Rp 1.480.000 (increased by 500.000)

**Formula:**
```
entry_amount = -500000 (negative = income)
flows_factor = -1 (asset account)
balance_change = -500000 * -1 = +500000
new_balance = 980000 + 500000 = 1480000 ✅
```

---

### Scenario 3: EDIT Transaction Amount (Asset Account)

**Setup:**
- Account: BCA Checking (Asset)
- Current Balance: Rp 1.480.000
- Existing expense: Rp 20.000 (warung makan)

**Actions:**
1. Edit transaction from Rp 20.000 to Rp 50.000

**Expected Results:**
- ✅ Balance immediately shows: Rp 1.450.000 (additional -30.000)

**Formula:**
```
old_amount = +20000
new_amount = +50000
flows_factor = -1 (asset account)

old_balance_change = 20000 * -1 = -20000
new_balance_change = 50000 * -1 = -50000
balance_delta = -50000 - (-20000) = -30000

new_balance = 1480000 + (-30000) = 1450000 ✅
```

---

### Scenario 4: EDIT Transaction Amount to Lower (Asset Account)

**Setup:**
- Account: BCA Checking (Asset)
- Current Balance: Rp 1.450.000
- Existing expense: Rp 50.000

**Actions:**
1. Edit transaction from Rp 50.000 to Rp 10.000

**Expected Results:**
- ✅ Balance immediately shows: Rp 1.490.000 (increase by +40.000)

**Formula:**
```
old_amount = +50000
new_amount = +10000
flows_factor = -1 (asset account)

old_balance_change = 50000 * -1 = -50000
new_balance_change = 10000 * -1 = -10000
balance_delta = -10000 - (-50000) = +40000

new_balance = 1450000 + 40000 = 1490000 ✅
```

---

### Scenario 5: DELETE Transaction (Asset Account)

**Setup:**
- Account: BCA Checking (Asset)
- Current Balance: Rp 1.490.000
- Existing expense: Rp 10.000

**Actions:**
1. Delete the expense transaction

**Expected Results:**
- ✅ Balance immediately shows: Rp 1.500.000 (reverse the -10.000 expense)
- ✅ Transaction removed from list without refresh

**Formula:**
```
entry_amount = +10000 (expense)
flows_factor = -1 (asset account)
# DELETE reverses the original effect
balance_change = -(10000 * -1) = +10000
new_balance = 1490000 + 10000 = 1500000 ✅
```

---

### Scenario 6: CREATE Expense on Credit Card (Liability Account)

**Setup:**
- Account: Mandiri Credit Card (Liability)
- Initial Balance: Rp 500.000 (debt)

**Actions:**
1. Create expense transaction: Rp 100.000 (belanja tokped)

**Expected Results:**
- ✅ Balance immediately shows: Rp 600.000 (debt increased by 100.000)

**Formula:**
```
entry_amount = +100000 (positive = expense)
flows_factor = +1 (liability account)
balance_change = 100000 * 1 = +100000
new_balance = 500000 + 100000 = 600000 ✅
```

---

### Scenario 7: CREATE Payment to Credit Card (Liability Account)

**Setup:**
- Account: Mandiri Credit Card (Liability)
- Current Balance: Rp 600.000 (debt)

**Actions:**
1. Create payment transaction: Rp 200.000 (bayar CC dari BCA)

**Expected Results:**
- ✅ Balance immediately shows: Rp 400.000 (debt decreased by 200.000)

**Formula:**
```
entry_amount = -200000 (negative = payment/income to liability)
flows_factor = +1 (liability account)
balance_change = -200000 * 1 = -200000
new_balance = 600000 + (-200000) = 400000 ✅
```

---

### Scenario 8: EDIT Credit Card Expense Amount

**Setup:**
- Account: Mandiri Credit Card (Liability)
- Current Balance: Rp 400.000
- Existing expense: Rp 100.000

**Actions:**
1. Edit from Rp 100.000 to Rp 150.000

**Expected Results:**
- ✅ Balance immediately shows: Rp 450.000 (additional +50.000 debt)

**Formula:**
```
old_amount = +100000
new_amount = +150000
flows_factor = +1 (liability account)

old_balance_change = 100000 * 1 = +100000
new_balance_change = 150000 * 1 = +150000
balance_delta = 150000 - 100000 = +50000

new_balance = 400000 + 50000 = 450000 ✅
```

---

### Scenario 9: DELETE Credit Card Expense

**Setup:**
- Account: Mandiri Credit Card (Liability)
- Current Balance: Rp 450.000
- Existing expense: Rp 150.000

**Actions:**
1. Delete the expense transaction

**Expected Results:**
- ✅ Balance immediately shows: Rp 300.000 (reverse the +150.000 debt)

**Formula:**
```
entry_amount = +150000 (expense)
flows_factor = +1 (liability account)
# DELETE reverses the original effect
balance_change = -(150000 * 1) = -150000
new_balance = 450000 + (-150000) = 300000 ✅
```

---

### Scenario 10: Rapid Multiple Transactions

**Setup:**
- Account: BCA Checking (Asset)
- Initial Balance: Rp 1.000.000

**Actions:**
1. Create expense: Rp 10.000 (kopi)
2. Create expense: Rp 20.000 (nasi goreng)
3. Create expense: Rp 30.000 (parkir)
4. Create income: Rp 100.000 (freelance)
5. Create expense: Rp 50.000 (bensin)

**Expected Results:**
- ✅ Each transaction shows immediate balance update
- ✅ Final balance: Rp 990.000
- ✅ No flickering or wrong values during rapid entry
- ✅ Debounce mechanism (5s) merges sync jobs efficiently

**Formula:**
```
Start: 1,000,000
- 10,000 (expense) = 990,000
- 20,000 (expense) = 970,000
- 30,000 (expense) = 940,000
+ 100,000 (income) = 1,040,000
- 50,000 (expense) = 990,000 ✅
```

---

## ⚠️ Edge Cases Handled

### Case 1: Currency Conversion
**Scenario:** Transaction in different currency than account
**Behavior:** Skip optimistic update, let async sync handle conversion
**Reason:** Complex conversion requires exchange rates

### Case 2: Old Transactions
**Scenario:** Edit/delete transaction older than 30 days
**Behavior:** Skip optimistic update, let async sync handle
**Reason:** Safety - older transactions may have historical implications

### Case 3: Account Change in Edit
**Scenario:** Edit transaction and change account_id
**Behavior:** Skip optimistic update for both accounts
**Reason:** Complex - affects two accounts, let async sync handle

### Case 4: New Account Without Balances
**Scenario:** First transaction on brand new account
**Behavior:** Skip optimistic update
**Reason:** No balance history yet, let async sync create initial balance

---

## 🎯 Success Criteria

For ALL scenarios above:
1. ✅ Balance updates immediately (< 100ms)
2. ✅ No wrong/ngaco values shown to user
3. ✅ UI doesn't require manual refresh
4. ✅ Async sync completes in < 5 seconds (not 2-3 hours!)
5. ✅ Final balance after sync matches optimistic balance
6. ✅ No flickering or jumping values
7. ✅ Works for both Asset and Liability accounts
8. ✅ Handles rapid multiple transactions gracefully

---

## 📊 Performance Expectations

### Before Fix:
- ❌ Wrong balance shows for 2-3 hours
- ❌ Balance calculation: Full history recalculation (minutes to hours)
- ❌ UI requires manual refresh
- ❌ Flickering during updates

### After Fix:
- ✅ Correct balance shows immediately (< 100ms)
- ✅ Balance calculation: Incremental (< 5 seconds)
- ✅ Auto UI refresh via Turbo
- ✅ Smooth, no flickering

---

**Testing Priority:** HIGH
**Test All Scenarios Before Production Deployment**
**Especially Test Scenarios 1-5 (most common user actions)**
