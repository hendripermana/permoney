# Database Restore Guide

## Quick Start

Restore your encrypted production database backup to local development:

```bash
# Simple - just run the script
bin/restore-db maybe_db_20251020_000001.dump.gpg
```

That's it! The script will guide you through the process.

---

## What the Script Does

1. ✅ Checks prerequisites (GPG, PostgreSQL, backup file)
2. ✅ Verifies database connection
3. ✅ Shows restore configuration
4. ⚠️  Asks for confirmation (will DROP existing database!)
5. 🔓 Decrypts the backup file (asks for GPG passphrase)
6. 🗑️  Drops existing database
7. 🆕 Creates new database
8. 📥 Restores data from backup
9. 🧹 Cleans up temporary files
10. ✅ Verifies restore
11. 🔄 Runs pending migrations
12. 🎉 Done!

---

## Prerequisites

### macOS
```bash
# Install PostgreSQL
brew install postgresql
brew services start postgresql

# Install GPG
brew install gnupg
```

### Ubuntu/Debian
```bash
# Install PostgreSQL
sudo apt-get update
sudo apt-get install postgresql postgresql-client

# Install GPG
sudo apt-get install gnupg

# Start PostgreSQL
sudo systemctl start postgresql
```

---

## Configuration

The script uses environment variables from `.env.local`:

```bash
DB_HOST=localhost
DB_PORT=5432
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
POSTGRES_DB=permoney_development  # Optional, defaults to this
```

---

## Usage Examples

### Basic Usage
```bash
# Restore with default settings
bin/restore-db maybe_db_20251020_000001.dump.gpg
```

### Custom Database Name
```bash
# Set custom database name
export POSTGRES_DB=permoney_staging
bin/restore-db maybe_db_20251020_000001.dump.gpg
```

### Different Backup File
```bash
# Restore from different backup
bin/restore-db path/to/other_backup.dump.gpg
```

---

## Troubleshooting

### "GPG is not installed"
```bash
# macOS
brew install gnupg

# Ubuntu
sudo apt-get install gnupg
```

### "PostgreSQL client (psql) is not installed"
```bash
# macOS
brew install postgresql

# Ubuntu
sudo apt-get install postgresql-client
```

### "Cannot connect to database server"
```bash
# Check if PostgreSQL is running
# macOS
brew services list
brew services start postgresql

# Ubuntu
sudo systemctl status postgresql
sudo systemctl start postgresql

# Test connection manually
psql -h localhost -U postgres -d postgres
```

### "Failed to decrypt backup file"
- Make sure you have the correct GPG passphrase
- The passphrase was used when creating the backup
- Contact the person who created the backup if you don't have it

### "Database already exists" or "Cannot drop database"
```bash
# Manually drop the database
psql -h localhost -U postgres -d postgres -c "DROP DATABASE permoney_development;"

# Then run restore again
bin/restore-db maybe_db_20251020_000001.dump.gpg
```

### "Permission denied"
```bash
# Make sure script is executable
chmod +x bin/restore-db

# Check database permissions
psql -h localhost -U postgres -d postgres -c "\du"
```

---

## Security Notes

### GPG Passphrase
- The backup is encrypted with GPG for security
- You'll be prompted for the passphrase during restore
- The passphrase is NOT stored anywhere
- The decrypted file is automatically deleted after restore

### Database Credentials
- Never commit `.env.local` to git
- Keep your database passwords secure
- Use strong passwords in production

### Backup Files
- Keep backup files secure
- Don't share encrypted backups without sharing the passphrase separately
- Store backups in a secure location

---

## Advanced Usage

### Restore to Different Host
```bash
export DB_HOST=192.168.1.100
export DB_PORT=5432
bin/restore-db backup.dump.gpg
```

### Restore Without Migrations
```bash
# Edit bin/restore-db and comment out the run_migrations function call
# Or manually restore:

# 1. Decrypt
gpg --decrypt --output backup.dump backup.dump.gpg

# 2. Drop and create database
psql -h localhost -U postgres -d postgres -c "DROP DATABASE permoney_development;"
psql -h localhost -U postgres -d postgres -c "CREATE DATABASE permoney_development;"

# 3. Restore
pg_restore --host=localhost --username=postgres --dbname=permoney_development --no-owner --no-acl backup.dump

# 4. Cleanup
rm backup.dump
```

### Verify Restore Manually
```bash
# Connect to database
psql -h localhost -U postgres -d permoney_development

# Check tables
\dt

# Check row counts
SELECT 
    schemaname,
    tablename,
    n_live_tup as row_count
FROM pg_stat_user_tables
ORDER BY n_live_tup DESC;

# Exit
\q
```

---

## Creating Backups

To create an encrypted backup (for reference):

```bash
# Dump database
pg_dump -h localhost -U postgres -Fc permoney_development > backup.dump

# Encrypt with GPG
gpg --symmetric --cipher-algo AES256 backup.dump

# This creates backup.dump.gpg
# Remove unencrypted file
rm backup.dump
```

---

## Post-Restore Checklist

After successful restore:

- [ ] Start Rails server: `bin/dev`
- [ ] Check application: http://localhost:3000
- [ ] Verify user accounts exist
- [ ] Check transactions data
- [ ] Verify accounts and balances
- [ ] Test loan features
- [ ] Test personal lending features
- [ ] Check settings and preferences

---

## Getting Help

If you encounter issues:

1. Check the error message carefully
2. Review the troubleshooting section above
3. Check PostgreSQL logs:
   - macOS: `~/Library/Application Support/Postgres/var-XX/postgresql.log`
   - Ubuntu: `/var/log/postgresql/postgresql-XX-main.log`
4. Verify your `.env.local` configuration
5. Make sure PostgreSQL is running

---

## Quick Reference

```bash
# Check PostgreSQL status
brew services list                    # macOS
sudo systemctl status postgresql      # Ubuntu

# Start PostgreSQL
brew services start postgresql        # macOS
sudo systemctl start postgresql       # Ubuntu

# Connect to database
psql -h localhost -U postgres -d permoney_development

# List databases
psql -h localhost -U postgres -d postgres -c "\l"

# Drop database
psql -h localhost -U postgres -d postgres -c "DROP DATABASE permoney_development;"

# Create database
psql -h localhost -U postgres -d postgres -c "CREATE DATABASE permoney_development;"
```

---

**Last Updated:** October 20, 2025  
**Script Version:** 1.0  
**Tested On:** macOS, Ubuntu 20.04+
