# 🚀 Cloudflare CDN Optimization Guide for Permoney

## Executive Summary

Panduan ini berisi konfigurasi optimal Cloudflare CDN untuk mempercepat aplikasi Permoney.
Karena Anda sudah menggunakan Cloudflare untuk DNS, sebagian besar optimasi dilakukan di **Cloudflare Dashboard**.

---

## 📊 Current Status

| Component | Status |
|-----------|--------|
| DNS via Cloudflare | ✅ Active |
| R2 Storage | ✅ Configured |
| Caddy Reverse Proxy | ✅ Active |
| Rails Cache Headers | ✅ 1 year for assets |

---

## 🎯 Phase 2: Cloudflare Dashboard Configuration

### 1. Cache Rules (Recommended - Modern Approach)

Go to: **Cloudflare Dashboard → Rules → Cache Rules**

#### Rule 1: Cache Static Assets Aggressively

```
Name: Cache Static Assets
When: URI Path matches /assets/*
Then:
  - Cache eligibility: Eligible for cache
  - Edge TTL: 1 month
  - Browser TTL: 1 month
  - Cache Key: Include query string
```

#### Rule 2: Cache Uploaded Images (R2 via Active Storage)

```
Name: Cache Active Storage Files
When: URI Path matches /rails/active_storage/*
Then:
  - Cache eligibility: Eligible for cache
  - Edge TTL: 1 week
  - Browser TTL: 1 day
```

#### Rule 3: Bypass Cache for API & Dynamic Content

```
Name: Bypass API and Dynamic
When: 
  - URI Path starts with /api OR
  - URI Path starts with /cable OR
  - URI Path contains /turbo
Then:
  - Cache eligibility: Bypass cache
```

#### Rule 4: Bypass Cache for Authenticated Pages

```
Name: Bypass Authenticated Content
When: Cookie contains "_permoney_session"
Then:
  - Cache eligibility: Bypass cache
```

---

### 2. Speed Optimization Settings

> **📝 Note (December 2025):** Cloudflare telah memperbarui UI dashboard. Menu **Speed** sekarang 
> menampilkan **Observatory** sebagai halaman utama. Pengaturan optimization tersebar di sub-menu.

#### 2a. Content Optimization
Go to: **Speed → Optimization → Content** (atau cari di sidebar kiri)

| Setting | Lokasi | Recommended | Notes |
|---------|--------|-------------|-------|
| **Auto Minify** | Content | CSS ✅, JS ✅, HTML ❌ | HTML punya Turbo frames |
| **Rocket Loader** | Content | ❌ **DISABLE** | Konflik dengan Turbo/Stimulus |
| **Early Hints** | Content | ✅ Enabled | Preload critical assets |

#### 2b. Protocol Optimization
Go to: **Speed → Optimization → Protocol**

| Setting | Recommended | Notes |
|---------|-------------|-------|
| **HTTP/2** | ✅ Enabled | Default aktif |
| **HTTP/3 (QUIC)** | ✅ Enabled | Modern protocol |

#### 2c. Compression
Go to: **Speed → Optimization → Content** atau **Network**

| Setting | Recommended | Notes |
|---------|-------------|-------|
| **Brotli** | ✅ Enabled | Better than gzip |

#### 2d. Image Optimization (Pro Plan+)
Go to: **Speed → Optimization → Images**

| Setting | Recommended | Notes |
|---------|-------------|-------|
| **Polish** | Lossy | Compress images (Pro+) |
| **WebP** | ✅ Enabled | Auto-convert (Pro+) |
| **Mirage** | ✅ Enabled | Lazy-load mobile (Pro+) |

> **💡 Free Plan Alternative:** Image optimization via R2 + Active Storage WebP variants 
> sudah kita implementasikan di Phase 1!

#### 2e. Smart Shield (New Feature!)
Go to: **Speed → Observatory → Suggestions → Smart Shield**

Smart Shield adalah fitur baru Cloudflare yang secara otomatis:
- Meningkatkan cache hit ratio
- Mengoptimalkan delivery berdasarkan traffic pattern
- **Recommended: Enable jika tersedia di plan Anda**

---

### 3. Security Headers via Transform Rules

Go to: **Rules → Transform Rules → Response Header Transform Rules**

#### Step-by-Step Instructions:

1. **Rule name**: `Security Headers`
2. **If incoming requests match**: Pilih **"All incoming requests"**
3. **Then... Modify response header**: Tambahkan 4 header berikut:

| Action | Header name | Value |
|--------|-------------|-------|
| **Set static** | `X-Frame-Options` | `SAMEORIGIN` |
| **Set static** | `X-Content-Type-Options` | `nosniff` |
| **Set static** | `Referrer-Policy` | `strict-origin-when-cross-origin` |
| **Set static** | `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` |

#### Cara menambahkan setiap header:
1. Klik dropdown → Pilih **"Set static"**
2. Di field **Header name** → ketik nama header (contoh: `X-Frame-Options`)
3. Di field **Value** → ketik value (contoh: `SAMEORIGIN`)
4. Klik **"+ Add header"** untuk menambah header berikutnya
5. Ulangi untuk semua 4 header
6. Klik **Deploy**

#### Penjelasan setiap header:
- **X-Frame-Options: SAMEORIGIN** → Mencegah clickjacking (iframe dari domain lain)
- **X-Content-Type-Options: nosniff** → Mencegah MIME-type sniffing
- **Referrer-Policy: strict-origin-when-cross-origin** → Kontrol info referrer
- **Permissions-Policy** → Disable kamera/mikrofon/geolokasi yang tidak dipakai

---

### 4. R2 Public Access with Custom Domain (⚠️ OPTIONAL)

> **📝 Untuk Permoney:** Section ini **OPTIONAL** dan kemungkinan tidak diperlukan.
> Cache Rules yang sudah Anda setup sudah memberikan efek yang sama!

#### Kenapa Optional?

Setup Anda saat ini:
```
User → Cloudflare CDN (cache 1 week) → Rails → R2 signed URL
```

Dengan Cache Rules aktif, file Active Storage sudah di-cache di Cloudflare edge.
**Ini sudah cukup optimal untuk aplikasi personal finance!**

#### ⚠️ JANGAN Jadikan Bucket Sekarang Public!

Bucket Anda berisi:
- ✅ Active Storage files (receipts, profile images)
- ⚠️ **Database backups** ← Ini HARUS tetap private!

**Jika Anda ingin R2 public access, buat bucket TERPISAH:**

| Bucket | Akses | Isi |
|--------|-------|-----|
| `permoney-storage` (existing) | **Private** | Active Storage + DB Backups |
| `permoney-public` (opsional) | Public | Static assets saja |

#### R2 Free Tier - Buat Bucket Baru GRATIS

| Resource | Free Tier |
|----------|-----------|
| **Jumlah Bucket** | Unlimited (GRATIS) |
| **Storage** | 10 GB total (semua bucket) |
| **Egress** | GRATIS tanpa batas |

> Anda bisa buat bucket sebanyak mungkin tanpa biaya tambahan!

#### Jika Tetap Ingin Setup (Future Reference)

**Option A: Skip untuk sekarang** ✅ Recommended
- Current setup sudah optimal dengan Cache Rules
- Lebih sederhana dan aman

**Option B: Buat Bucket Terpisah untuk Public Assets**
1. Buat bucket baru: `permoney-public`
2. Enable Public Access pada bucket baru
3. Add Custom Domain: `assets.permana.icu`
4. Gunakan untuk static assets yang benar-benar public

Untuk saat ini, **lewati Phase 4 dan lanjut ke Phase 5 atau selesai!** 🎉

---

### 5. Argo Smart Routing (Premium - Optional)

Go to: **Cloudflare Dashboard → Traffic → Argo**

Benefits:
- 🚀 30% faster response times on average
- 🔄 Automatic route optimization
- 💰 ~$5/month + $0.10 per GB

Recommended for production apps with global users.

---

### 6. Cache Analytics & Purge

Go to: **Cloudflare Dashboard → Caching → Overview**

#### Monitor:
- Cache Hit Ratio (target: >90% for assets)
- Bandwidth saved
- Requests by cache status

#### Purge Strategies:
- **Purge Everything**: After major deployments
- **Purge by URL**: For specific asset updates
- **Purge by Tag**: If using Cache-Tag headers

#### CI/CD Integration (Optional):
```bash
# Add to deployment script
curl -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/purge_cache" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"purge_everything":true}'
```

---

## 🔧 Rails Code Optimizations (Already Applied)

### Current Cache Headers (production.rb line 19):
```ruby
config.public_file_server.headers = { 
  "cache-control" => "public, max-age=#{1.year.to_i}" 
}
```
✅ This is optimal for fingerprinted assets.

### Recommended Addition - Active Storage Cache Headers:

```ruby
# config/initializers/active_storage.rb
Rails.application.config.after_initialize do
  # Set cache headers for Active Storage blobs
  ActiveStorage::Blob.update_all_service_urls = false
  
  # Variant transformations are cached by Cloudflare
  # No code change needed - handled by R2 + CDN
end
```

---

## 📋 Implementation Checklist

### Cloudflare Dashboard Tasks:
- [ ] Create Cache Rule: Static Assets (1 month)
- [ ] Create Cache Rule: Active Storage (1 week)
- [ ] Create Cache Rule: Bypass API/Turbo
- [ ] Create Cache Rule: Bypass Authenticated
- [ ] Enable Auto Minify (CSS, JS only)
- [ ] Enable Brotli compression
- [ ] Enable Early Hints
- [ ] Disable Rocket Loader
- [ ] Enable HTTP/2 and HTTP/3
- [ ] Enable Polish (Lossy + WebP)
- [ ] Enable Mirage
- [ ] Add Security Headers Transform Rule
- [ ] Configure R2 Custom Domain (optional)
- [ ] Review Cache Analytics after 24 hours

### Rails Code Tasks (Optional):
- [ ] Add asset_host if using R2 custom domain
- [ ] Add cache purge to CI/CD pipeline

---

## 🎯 Expected Results

After implementing these optimizations:

| Metric | Before | After (Expected) |
|--------|--------|------------------|
| TTFB | ~200ms | ~50-100ms |
| Asset Load | ~1-2s | ~200-500ms |
| Cache Hit Ratio | N/A | >90% |
| Bandwidth | 100% origin | ~10% origin |
| Lighthouse Score | ~70-80 | ~90+ |

---

## ⚠️ Important Notes

1. **Rocket Loader**: Harus dimatikan karena konflik dengan Turbo/Stimulus
2. **HTML Caching**: Jangan cache HTML karena ada CSRF tokens dan session data
3. **WebSocket (Turbo)**: `/cable` harus bypass cache
4. **Purge setelah deploy**: Penting untuk memastikan assets baru terkirim

---

*Guide created: 2025-12-07*
*For domain: finance.permana.icu / permana.icu*
