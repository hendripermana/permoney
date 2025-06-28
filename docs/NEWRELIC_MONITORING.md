# New Relic Monitoring Setup untuk Maybe App

## Overview
Setup ini mengaktifkan monitoring New Relic untuk aplikasi Maybe Finance dengan konfigurasi yang lengkap untuk Ruby on Rails dan Sidekiq.

## Files yang Ditambahkan/Dimodifikasi

### 1. `newrelic.yml` (ROOT)
- Konfigurasi utama New Relic untuk Ruby agent
- Environment-specific settings (development, test, staging, production)
- Monitoring untuk transaction tracer, error collector, browser monitoring
- Support untuk Sidekiq background jobs

### 2. `config/initializers/newrelic.rb`
- Initializer Rails untuk konfigurasi tambahan
- Custom attributes dan events
- Error filtering
- Logging konfigurasi

### 3. `compose.yml` (Modified)
- Environment variables NEW_RELIC_LICENSE_KEY dan NEW_RELIC_APP_NAME
- Tersedia untuk service web dan worker

### 4. `scripts/backup/backup_config_snapshot.sh` (Modified)
- Menambahkan newrelic.yml ke dalam backup configuration

### 5. `bin/verify-newrelic.sh`
- Script verifikasi untuk memastikan setup New Relic benar

## Environment Variables Required

Pastikan file `.env` mengandung:
```bash
NEW_RELIC_LICENSE_KEY=your_license_key_here
NEW_RELIC_APP_NAME="Maybe App"
```

## Deployment Checklist

- [x] File newrelic.yml ada di root project
- [x] Environment variables ditambahkan ke .env
- [x] newrelic_rpm gem sudah ada di Gemfile
- [x] File newrelic.yml tidak di-ignore (.gitignore/.dockerignore)
- [x] Environment variables tersedia di docker-compose
- [x] Initializer Rails dibuat untuk konfigurasi tambahan

## Verifikasi

Jalankan script verifikasi:
```bash
./bin/verify-newrelic.sh
```

Setelah deploy, cek logs untuk memastikan New Relic aktif:
```bash
docker compose logs web | grep -i newrelic
```

## Monitoring Yang Tersedia

1. **Application Performance Monitoring (APM)**
   - Request throughput dan response time
   - Database query performance
   - Error tracking dan alerting

2. **Background Jobs (Sidekiq)**
   - Job performance dan queue depth
   - Failed job tracking

3. **Infrastructure Monitoring**
   - Server metrics (CPU, memory, disk)
   - Container metrics

4. **Custom Events**
   - App startup events
   - Business metrics (dapat ditambahkan sesuai kebutuhan)

## Dashboard New Relic

Akses monitoring di: https://one.newrelic.com

Data akan mulai muncul 5-10 menit setelah aplikasi berjalan dan ada traffic.

## Troubleshooting

Jika data tidak muncul di New Relic:
1. Cek logs: `docker compose logs web | grep -i newrelic`
2. Pastikan license key valid
3. Pastikan environment = production
4. Generate traffic ke aplikasi
5. Tunggu 5-10 menit untuk data pertama
