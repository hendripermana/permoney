# 🔄 Panduan Update Aplikasi Permoney

## 📦 **Current Build Strategy: Local Build**

Karena image `ghcr.io/hendripermana/permoney:latest` mungkin private atau belum tersedia public, kita menggunakan **local build strategy**.

---

## 🚀 **Cara Update Aplikasi (Simple)**

### Step 1: Pull Latest Code
```bash
cd /home/ubuntu/permoney
git pull origin main
```

### Step 2: Check for Changes
```bash
git log --oneline -5
# Lihat commit terbaru untuk tahu apa yang berubah
```

### Step 3: Rebuild Image
```bash
docker compose build --no-cache
```

### Step 4: Run Migrations (if any)
```bash
docker compose run --rm web bin/rails db:migrate
```

### Step 5: Restart Services
```bash
docker compose up -d
```

### Step 6: Verify
```bash
docker compose ps
docker compose logs web | tail -20
```

---

## ⚡ **Quick Update Command (One-Liner)**

```bash
cd /home/ubuntu/permoney && \
git pull origin main && \
docker compose build && \
docker compose run --rm web bin/rails db:migrate && \
docker compose up -d && \
docker compose ps
```

---

## 🔄 **Update Scenarios**

### Scenario 1: Minor Update (No Breaking Changes)
```bash
cd /home/ubuntu/permoney
git pull origin main
docker compose up -d --build
# Docker Compose akan detect changes dan rebuild otomatis
```

### Scenario 2: Major Update (Schema Changes)
```bash
# 1. Backup dulu!
docker exec permoney-db-1 pg_dump -U postgres -Fc maybe_production > ~/backup-before-update-$(date +%Y%m%d).dump

# 2. Update code
cd /home/ubuntu/permoney
git pull origin main

# 3. Rebuild
docker compose build --no-cache

# 4. Run migrations
docker compose run --rm web bin/rails db:migrate

# 5. Restart
docker compose up -d

# 6. Verify
docker compose exec db psql -U postgres -d maybe_production -c "SELECT count(*) FROM accounts;"
```

### Scenario 3: Update to Specific Version
```bash
cd /home/ubuntu/permoney
git fetch --all --tags
git checkout v0.9.6  # atau tag/version tertentu
docker compose build --no-cache
docker compose run --rm web bin/rails db:migrate
docker compose up -d
```

---

## 🏷️ **Check Available Versions**

```bash
# List all releases
curl -s https://api.github.com/repos/hendripermana/permoney/releases | grep -o '"tag_name": "[^"]*' | cut -d'"' -f4

# Or via git
cd /home/ubuntu/permoney
git fetch --all --tags
git tag -l
```

---

## 🔮 **Future: Switching to GHCR Images (When Available)**

Jika nanti maintainer sudah publish image public ke GHCR, kamu bisa switch ke:

### Option A: Use Latest Tag
```yaml
# compose.yml
services:
  web:
    image: ghcr.io/hendripermana/permoney:latest
    # Remove build section
  
  worker:
    image: ghcr.io/hendripermana/permoney:latest
    # Remove build section
```

### Option B: Use Specific Version (Recommended)
```yaml
# compose.yml
services:
  web:
    image: ghcr.io/hendripermana/permoney:v0.9.6
  
  worker:
    image: ghcr.io/hendripermana/permoney:v0.9.6
```

**Update command dengan GHCR:**
```bash
docker compose pull  # Pull latest image
docker compose up -d
```

---

## 🧪 **Testing Updates in Safe Environment**

Sebelum update production, test dulu:

### Create Test Instance
```bash
# 1. Clone ke folder terpisah
cp -r /home/ubuntu/permoney /home/ubuntu/permoney-test

# 2. Update compose.yml untuk use different ports
cd /home/ubuntu/permoney-test
# Edit compose.yml: ports: - 3001:3000 (instead of 3000:3000)

# 3. Use separate volumes (or copy existing)
docker volume create postgres-data-test
docker volume create app-storage-test
docker volume create redis-data-test

# 4. Edit compose.yml to use -test volumes

# 5. Test update
git pull origin main
docker compose build
docker compose up -d

# 6. Test di http://localhost:3001
```

---

## 📊 **Update Frequency Recommendations**

| Type | Frequency | Command |
|------|-----------|---------|
| **Security Updates** | Immediately | `git pull && docker compose build && docker compose up -d` |
| **Feature Updates** | Weekly/Monthly | Review changelog first, then update |
| **Major Versions** | Quarterly | Full backup + test environment first |
| **Database Schema** | As needed | Always backup before migration |

---

## 🚨 **Rollback Procedure**

Jika update bermasalah:

### Quick Rollback (Recent Update)
```bash
cd /home/ubuntu/permoney
git log --oneline -10
git checkout <previous-commit-hash>
docker compose build --no-cache
docker compose up -d
```

### Full Rollback (Database + Code)
```bash
# 1. Stop services
docker compose down

# 2. Restore database from backup
docker compose up -d db
docker exec -i permoney-db-1 pg_restore -U postgres -d maybe_production -c < ~/backup-before-update-*.dump

# 3. Rollback code
git checkout <previous-version>
docker compose build
docker compose up -d
```

---

## 📝 **Update Log Template**

Keep a log of updates:
```bash
# /home/ubuntu/update-log.txt
Date: 2025-11-05
Version: v0.9.5 -> v0.9.6
Changes: Added recurring transactions, pay-later compliance
Backup: backup-before-update-20251105.dump
Status: Success
Notes: Ran 4 new migrations
```

---

## 💡 **Pro Tips**

1. **Always backup before update**
   ```bash
   docker exec permoney-db-1 pg_dump -U postgres -Fc maybe_production > ~/backup-$(date +%Y%m%d-%H%M%S).dump
   ```

2. **Monitor logs during update**
   ```bash
   docker compose logs -f web worker
   ```

3. **Check for breaking changes**
   ```bash
   cd /home/ubuntu/permoney
   git log --oneline origin/main..HEAD
   git show HEAD:CHANGELOG.md  # if exists
   ```

4. **Test critical features after update**
   - Login
   - Create transaction
   - View dashboard
   - Check balance calculations

5. **Keep old backups**
   - Daily backups: 7 days
   - Weekly backups: 4 weeks
   - Monthly backups: 6 months
   - Major version backups: Keep indefinitely

---

## 🔗 **Resources**

- **Repository**: https://github.com/hendripermana/permoney
- **Releases**: https://github.com/hendripermana/permoney/releases
- **Issues**: https://github.com/hendripermana/permoney/issues
- **GHCR Publish Guide**: See `/home/ubuntu/permoney/GHCR_PUBLISH_GUIDE.md`

---

**Last Updated**: November 5, 2025  
**Build Strategy**: Local (build from source)  
**Current Version**: v0.9.5 (+ local commits)
