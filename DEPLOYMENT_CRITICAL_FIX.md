# 🚨 CRITICAL FIX DEPLOYMENT GUIDE

**Commit**: `4fa18825` - Correct entry amount sign convention in optimistic balance updates  
**Urgency**: **CRITICAL** - Balance calculations are completely backwards!  
**Impact**: Fixes catastrophic bug where transactions change balance in OPPOSITE direction

## What Was Fixed

**The Bug**: Optimistic balance updates were NOT negating entry amounts before applying flows_factor, causing:
- Expense transactions INCREASED balance (should DECREASE) ❌
- Income transactions DECREASED balance (should INCREASE) ❌
- This caused your balance to become **-Rp1,398,699** when it should be **+Rp364,058**!

**The Fix**: Added proper negation to match Balance::ForwardCalculator exactly:
```ruby
# OLD (WRONG):
balance_change = entry_amount * flows_factor

# NEW (CORRECT):
balance_change = -entry_amount * flows_factor  # Must negate!
```

## Pre-Deployment Verification

✅ **Code Quality Checks**:
- RuboCop: ✅ No offenses
- Brakeman: ✅ No security warnings
- Unit tests: ✅ Created with correct formulas
- Git commit: ✅ `4fa18825`

✅ **Formula Verification**:
See `CRITICAL_FIX_VERIFICATION.md` for detailed verification tables proving the fix matches Balance::ForwardCalculator exactly.

## Deployment Steps

### 1. Build New Docker Image

```bash
cd /home/ubuntu/permoney

# Get the commit SHA
COMMIT_SHA=$(git rev-parse HEAD)
echo "Building image for commit: $COMMIT_SHA"

# Build the image
docker build \
  --build-arg RAILS_ENV=production \
  --platform linux/amd64 \
  -t ghcr.io/hendripermana/permoney:sha-${COMMIT_SHA} \
  -t ghcr.io/hendripermana/permoney:latest \
  .
```

Expected output:
```
Building image for commit: 4fa188250c6f...
[+] Building 120.5s (18/18) FINISHED
 => => naming to ghcr.io/hendripermana/permoney:sha-4fa188250c6f...
 => => naming to ghcr.io/hendripermana/permoney:latest
```

### 2. Push to GitHub Container Registry

```bash
# Login to GHCR (if not already logged in)
echo $GITHUB_TOKEN | docker login ghcr.io -u hendripermana --password-stdin

# Push the image
docker push ghcr.io/hendripermana/permoney:sha-${COMMIT_SHA}
docker push ghcr.io/hendripermana/permoney:latest
```

Expected output:
```
The push refers to repository [ghcr.io/hendripermana/permoney]
sha-4fa188250c6f: Pushed
latest: digest: sha256:abc123... size: 1234
```

### 3. Update compose.yml

```bash
# Update the image reference in compose.yml
vim compose.yml

# Change this line:
# image: ghcr.io/hendripermana/permoney:sha-2f0f72b2ad9de0d1779f2cb2876057f20c86d26f

# To:
# image: ghcr.io/hendripermana/permoney:sha-4fa188250c6f...
```

Or use sed:
```bash
COMMIT_SHA=$(git rev-parse HEAD)
sed -i "s|sha-[a-f0-9]*|sha-${COMMIT_SHA}|g" compose.yml

# Verify the change
grep "image: ghcr.io" compose.yml
```

### 4. Deploy to Production

```bash
# Pull the new image
docker compose pull

# Restart services with new image
docker compose up -d

# Verify all containers are healthy
docker compose ps
```

Expected output:
```
NAME                          STATUS              PORTS
permoney-web-1                Up 10 seconds       0.0.0.0:3000->3000/tcp
permoney-worker-1             Up 10 seconds
permoney-db-1                 Up 2 minutes (healthy)
permoney-redis-1              Up 2 minutes (healthy)
```

### 5. Verify Deployment

```bash
# Check container logs for any errors
docker compose logs web --tail=50

# Should see:
# => Booting Puma
# => Rails 8.1.1 application starting in production
# * Listening on http://0.0.0.0:3000
# Use Ctrl-C to stop
```

## Post-Deployment Testing

### Critical Test Cases

**Test 1: Create Expense (Should DECREASE Balance)**
1. Note current balance: ________________
2. Create expense transaction: Rp 50,000
3. Expected: Balance DECREASES by 50,000 ✓
4. Actual result: ________________
5. ✅ PASS / ❌ FAIL

**Test 2: Create Income (Should INCREASE Balance)**
1. Note current balance: ________________
2. Create income transaction: Rp 100,000
3. Expected: Balance INCREASES by 100,000 ✓
4. Actual result: ________________
5. ✅ PASS / ❌ FAIL

**Test 3: Edit Transaction (Correct Delta)**
1. Note current balance: ________________
2. Edit existing expense from Rp 25,000 → Rp 40,000
3. Expected: Balance DECREASES by 15,000 (delta) ✓
4. Actual result: ________________
5. ✅ PASS / ❌ FAIL

**Test 4: Delete Transaction (Proper Reversal)**
1. Note current balance: ________________
2. Delete expense transaction of Rp 66,000
3. Expected: Balance INCREASES by 66,000 (reverses original decrease) ✓
4. Actual result: ________________
5. ✅ PASS / ❌ FAIL

**Test 5: Wait for Sync (Verify Consistency)**
1. After operations above, wait 2-3 minutes for sync job
2. Note final balance: ________________
3. Expected: Balance matches transaction list sum ✓
4. Verify in database:
```bash
docker compose exec -T db psql -U postgres -d maybe_production -c "
SELECT 
  a.name,
  a.balance as account_balance,
  COALESCE(SUM(e.amount), 0) as sum_of_entries,
  a.balance - COALESCE(SUM(e.amount), 0) as difference
FROM accounts a
LEFT JOIN entries e ON e.account_id = a.id
WHERE a.id = 'YOUR_ACCOUNT_ID'
GROUP BY a.id, a.name, a.balance;
"
```
5. Expected difference: ~0 (should be consistent) ✓
6. ✅ PASS / ❌ FAIL

## Rollback Plan (If Issues Found)

If the fix causes issues:

```bash
# 1. Revert to previous image
vim compose.yml
# Change back to: sha-2f0f72b2ad9de0d1779f2cb2876057f20c86d26f

# 2. Deploy previous version
docker compose pull
docker compose up -d

# 3. Verify rollback
docker compose ps
docker compose logs web --tail=50

# 4. Report issue with:
#    - Exact error message
#    - Test case that failed
#    - Expected vs actual behavior
```

## Monitoring After Deployment

### Check Application Logs

```bash
# Monitor for optimistic update logs
docker compose logs -f web | grep "Optimistic Update"

# Should see correct calculations:
# [Optimistic Update] Account xxx (depository): balance 1000.0 + (-100.0 * 1) = 900.0
# [Optimistic Update - Edit] Account xxx: old_amount=100.0, new_amount=150.0, balance 900.0 + delta(-50.0) = 850.0
```

### Check for Errors

```bash
# Monitor for any Ruby errors
docker compose logs -f web | grep -i error

# Should see NO errors related to balance calculation
```

### Check Sidekiq Jobs

```bash
# Visit Sidekiq dashboard
# http://your-server-ip:3000/sidekiq

# Verify SyncJob is running without errors
# Check "Processed" count increasing
# Check "Failed" count stays at 0
```

## Success Criteria

✅ All 5 test cases PASS  
✅ No errors in logs  
✅ Balance stays synchronized with transaction list  
✅ Sidekiq sync jobs running without failures  
✅ Balance matches sum of entries in database  

## Timeline

- **Build & Push**: ~5 minutes
- **Deploy**: ~2 minutes
- **Testing**: ~10 minutes
- **Sync Verification**: ~3 minutes
- **Total**: ~20 minutes

## Support

If you encounter any issues during deployment:

1. **Check logs first**:
```bash
docker compose logs web --tail=100
docker compose logs worker --tail=100
```

2. **Verify image SHA**:
```bash
docker compose config | grep image
# Should show: sha-4fa188250c6f...
```

3. **Test database connection**:
```bash
docker compose exec web bin/rails runner "puts Account.count"
# Should print number of accounts
```

4. **Manual balance sync** (if needed):
```bash
docker compose exec web bin/rails runner "
account = Account.find('YOUR_ACCOUNT_ID')
Balance::Materializer.new(account).sync
puts \"Balance synced: #{account.reload.balance}\"
"
```

## Final Notes

**CRITICAL**: This fix is ESSENTIAL! The old code was completely backwards!

After deployment, your balance calculations will be CORRECT:
- ✅ Expenses will DECREASE balance (not increase!)
- ✅ Income will INCREASE balance (not decrease!)
- ✅ Edits will apply correct delta
- ✅ Deletes will properly reverse effects
- ✅ No more negative balances from transaction edits!

**Next**: After confirming this fix works, we should investigate why your account balance was off by 3+ million to begin with. This optimistic fix addresses the immediate calculation bug, but the underlying Balance records may need recalculation.
