# CRITICAL FIX VERIFICATION: Entry Amount Sign Convention

**Date**: 2025-11-14  
**Commit**: `4fa18825`  
**Issue**: Optimistic balance updates used WRONG sign convention, causing balance to change in OPPOSITE direction

## Root Cause Analysis

### The Bug

**WRONG Formula (Previous Code)**:
```ruby
balance_change = entry_amount * flows_factor
```

**CORRECT Formula (Fixed Code)**:
```ruby
balance_change = -entry_amount * flows_factor  # MUST NEGATE!
```

### Why This Matters

The entry amount convention in Permoney is:
- `nature = "inflow"` (income) → `amount` stored as **NEGATIVE**
- `nature = "outflow"` (expense) → `amount` stored as **POSITIVE**

Balance::ForwardCalculator applies this formula:
```ruby
def signed_entry_flows(entries)
  entry_flows = entries.sum(&:amount)
  account.asset? ? -entry_flows : entry_flows  # Negates for assets!
end
```

But our optimistic updates were NOT negating! This caused:
- Asset expense (+100) → balance INCREASED by 100 ✗ WRONG!
- Should have DECREASED by 100 ✓

## Verification Table

### Asset Account (flows_factor = 1)

| Transaction Type | Entry Amount | OLD Formula | OLD Result | NEW Formula | NEW Result | Correct? |
|-----------------|--------------|-------------|------------|-------------|------------|----------|
| Expense | +100 | `100 * 1 = +100` | Balance INCREASES | `-100 * 1 = -100` | Balance DECREASES | ✅ |
| Income | -200 | `-200 * 1 = -200` | Balance DECREASES | `-(-200) * 1 = +200` | Balance INCREASES | ✅ |

### Liability Account (flows_factor = -1)

| Transaction Type | Entry Amount | OLD Formula | OLD Result | NEW Formula | NEW Result | Correct? |
|-----------------|--------------|-------------|------------|-------------|------------|----------|
| Expense | +100 | `100 * -1 = -100` | Debt DECREASES | `-100 * -1 = +100` | Debt INCREASES | ✅ |
| Payment | -200 | `-200 * -1 = +200` | Debt INCREASES | `-(-200) * -1 = -200` | Debt DECREASES | ✅ |

## Code Changes

### 1. CREATE Action (transactions_controller.rb)

**Before**:
```ruby
flows_factor = account.asset? ? 1 : -1
balance_change = entry_amount * flows_factor  # WRONG!
new_balance = account.balance + balance_change
```

**After**:
```ruby
flows_factor = account.asset? ? 1 : -1
balance_change = -entry_amount * flows_factor  # CORRECT with negation!
new_balance = account.balance + balance_change
```

### 2. UPDATE Action (transactions_controller.rb)

**Before**:
```ruby
old_balance_change = old_amount * flows_factor  # WRONG!
new_balance_change = new_amount * flows_factor  # WRONG!
balance_delta = new_balance_change - old_balance_change
```

**After**:
```ruby
old_balance_change = -old_amount * flows_factor  # CORRECT!
new_balance_change = -new_amount * flows_factor  # CORRECT!
balance_delta = new_balance_change - old_balance_change
```

### 3. DELETE Action (entryable_resource.rb)

**Before**:
```ruby
balance_change = -(entry_amount * flows_factor)  # Double negation, WRONG!
```

**After**:
```ruby
balance_change = entry_amount * flows_factor  # Reverses negated CREATE effect, CORRECT!
```

## Real-World Impact

**User's Production Issue**:
- Edited 2 transactions: 25k→40k and 66k→51k
- Expected balance: ~364,058
- Actual balance: **-1,398,699** (NEGATIVE and off by 3+ million!)
- Manual sync produced SAME wrong value

**Root Cause**:
Old optimistic formula was completely backwards, applying changes in OPPOSITE direction!

## Verification Against Balance::ForwardCalculator

Balance calculator code (app/models/balance/forward_calculator.rb:134-137):
```ruby
# Negative entries amount on an "asset" account means, "account value has increased"
# Negative entries amount on a "liability" account means, "account debt has decreased"
# Positive entries amount on an "asset" account means, "account value has decreased"
# Positive entries amount on a "liability" account means, "account debt has increased"
def signed_entry_flows(entries)
  entry_flows = entries.sum(&:amount)
  account.asset? ? -entry_flows : entry_flows
end
```

Our CORRECTED optimistic formula EXACTLY matches this logic:
```ruby
# For asset: -entry_amount * 1 = -entry_amount (same as Balance calculator)
# For liability: -entry_amount * -1 = entry_amount (same as Balance calculator)
balance_change = -entry_amount * flows_factor
```

## Testing

### Unit Tests Created

Created comprehensive unit tests in `test/controllers/transactions_optimistic_balance_test.rb`:
- ✅ CREATE expense on asset account (should DECREASE balance)
- ✅ CREATE income on asset account (should INCREASE balance)
- ✅ CREATE expense on liability account (should INCREASE debt)
- ✅ CREATE payment on liability account (should DECREASE debt)
- ✅ UPDATE transaction with delta calculation
- ✅ DELETE transaction with reversal logic
- ✅ Edge cases (currency mismatch, old dates)

All tests use CORRECTED formula: `expected_balance = initial_balance + (-entry_amount * flows_factor)`

### Quality Checks

```bash
✅ RuboCop: 2 files inspected, no offenses detected
✅ Brakeman: No security warnings found
✅ Git: Committed as 4fa18825
```

## Next Steps for Production Deployment

1. **Build new Docker image** with commit `4fa18825`
2. **Push to GHCR** with new sha tag
3. **Update compose.yml** image reference
4. **Deploy to production**
5. **Test transaction operations**:
   - Create expense → verify balance DECREASES
   - Create income → verify balance INCREASES
   - Edit transaction → verify delta is correct
   - Delete transaction → verify reversal works
6. **Monitor Balance sync** to ensure consistency

## Expected Results

After deployment:
- ✅ Creating expense will DECREASE asset balance (not increase!)
- ✅ Creating income will INCREASE asset balance (not decrease!)
- ✅ Editing transactions will apply correct delta
- ✅ Deleting transactions will properly reverse effect
- ✅ Balance will stay synchronized with Transaction list
- ✅ No more negative balances from edits!

## References

- **Balance Calculator**: `app/models/balance/forward_calculator.rb`
- **Entry Amount Convention**: `app/controllers/transactions_controller.rb:285-290`
- **Commit History**: 
  - `2f0f72b2` - Fixed flows_factor convention (still had sign bug)
  - `4fa18825` - Fixed entry amount sign convention (COMPLETE FIX)
