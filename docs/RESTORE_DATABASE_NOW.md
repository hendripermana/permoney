# 🚀 Restore Database NOW - Quick Guide

## ✅ Prerequisites Check

Semua sudah siap:
- ✅ GPG installed: `/opt/homebrew/bin/gpg`
- ✅ PostgreSQL installed: `/opt/homebrew/opt/postgresql@17/bin/psql`
- ✅ Backup file ready: `maybe_db_20251020_000001.dump.gpg` (509 KB)
- ✅ Database connection: Working
- ✅ Restore script: `bin/restore-db` (ready to use)

---

## 🎯 Option 1: Interactive Restore (Recommended)

Jalankan command ini dan ikuti prompt:

```bash
./bin/restore-db maybe_db_20251020_000001.dump.gpg
```

**Steps:**
1. Script akan menampilkan informasi restore
2. Ketik `yes` untuk confirm
3. Masukkan GPG passphrase saat diminta
4. Tunggu proses selesai (1-2 menit)
5. Done! ✅

---

## 🎯 Option 2: Automated Restore (No Prompts)

Jika Anda ingin skip confirmation prompt:

```bash
# Create auto-confirm wrapper
echo "yes" | ./bin/restore-db maybe_db_20251020_000001.dump.gpg
```

**Note:** Anda tetap akan diminta GPG passphrase (ini tidak bisa di-skip untuk keamanan)

---

## 📋 What Will Happen

```
1. ✅ Check prerequisites (GPG, PostgreSQL, backup file)
2. ✅ Verify database connection
3. ⚠️  DROP database: permoney_development
4. 🆕 CREATE database: permoney_development
5. 🔓 Decrypt backup (GPG passphrase required)
6. 📥 Restore data from backup
7. 🧹 Cleanup temporary files
8. ✅ Verify restore (count tables, show stats)
9. 🔄 Run pending migrations
10. 🎉 Done!
```

---

## 🔐 GPG Passphrase

Anda akan diminta memasukkan GPG passphrase yang digunakan saat membuat backup.

**Jika Anda lupa passphrase:**
- Hubungi orang yang membuat backup
- Atau gunakan backup yang tidak di-encrypt

---

## ⚡ Quick Commands

### Start Restore
```bash
./bin/restore-db maybe_db_20251020_000001.dump.gpg
```

### Check PostgreSQL Status
```bash
brew services list | grep postgresql
```

### Start PostgreSQL (if not running)
```bash
brew services start postgresql
```

### Connect to Database After Restore
```bash
psql -h localhost -U postgres -d permoney_development
```

### Start Rails Server After Restore
```bash
bin/dev
```

---

## 🎯 Expected Output

```
================================================
  Permoney Database Restore
================================================

ℹ Checking prerequisites...
✓ Backup file found: maybe_db_20251020_000001.dump.gpg
✓ GPG is installed
✓ PostgreSQL client is installed
✓ pg_restore is installed

ℹ Checking database connection...
✓ Database connection successful

ℹ Restore Configuration:
  Backup file: maybe_db_20251020_000001.dump.gpg
  Database: permoney_development
  Host: localhost
  Port: 5432
  User: postgres

⚠ ⚠️  WARNING: This will DROP and RECREATE the database!
⚠ ⚠️  All existing data in 'permoney_development' will be LOST!

Are you sure you want to continue? (yes/no): yes

ℹ Decrypting backup file...
You will be prompted for the GPG passphrase.

[Enter passphrase here]

✓ Backup decrypted successfully: maybe_db_20251020_000001.dump

ℹ Dropping existing database...
✓ Database dropped

ℹ Creating new database...
✓ Database created: permoney_development

ℹ Restoring database from backup...
This may take a few minutes depending on the backup size...

[Restore progress...]

✓ Database restored successfully!

ℹ Cleaning up temporary files...
✓ Temporary files removed

ℹ Verifying restore...
✓ Database verified: 45 tables found

ℹ Database Statistics:
[Table statistics...]

ℹ Running pending migrations...
✓ Migrations completed

================================================
  Permoney Database Restore
================================================
✓ Database restore completed successfully!

ℹ Next steps:
  1. Start the Rails server: bin/dev
  2. Check the application: http://localhost:3000
  3. Verify your data is correct

ℹ Database: permoney_development
ℹ Host: localhost:5432

✓ You're all set! 🎉
```

---

## 🐛 Troubleshooting

### "Cannot connect to database server"
```bash
# Start PostgreSQL
brew services start postgresql

# Wait a few seconds, then try again
./bin/restore-db maybe_db_20251020_000001.dump.gpg
```

### "Failed to decrypt backup file"
- Check GPG passphrase
- Make sure you're using the correct passphrase
- Contact backup creator if needed

### "Permission denied"
```bash
# Make script executable
chmod +x bin/restore-db

# Try again
./bin/restore-db maybe_db_20251020_000001.dump.gpg
```

---

## ✅ Post-Restore Checklist

After successful restore:

```bash
# 1. Start Rails server
bin/dev

# 2. Open browser
open http://localhost:3000

# 3. Check data
# - Login with your production credentials
# - Verify accounts exist
# - Check transactions
# - Test loan features
# - Verify balances
```

---

## 🎉 Ready to Restore?

Just run:

```bash
./bin/restore-db maybe_db_20251020_000001.dump.gpg
```

And follow the prompts! 🚀

---

**Created:** October 20, 2025  
**Backup File:** maybe_db_20251020_000001.dump.gpg (509 KB)  
**Target Database:** permoney_development  
**Status:** ✅ Ready to restore
