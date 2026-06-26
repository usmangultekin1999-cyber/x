# X Safe Worker Manager

Cloudflare Workers üzerinde çalışan, D1 veritabanı kullanan, OAuth 2.0 PKCE ile X hesaplarını bağlayan güvenli yayın yönetim paneli.

Bu proje, yetkili hesaplarda içerik yayınlama ve planlama içindir. Toplu otomatik beğeni/RT, sahte etkileşim, hashtag/keşfet manipülasyonu veya spam amaçlı kullanım için tasarlanmamıştır. Uygulama aynı metni birden fazla hesaba aynı anda göndermeyi engeller ve beğeni/RT işlemlerini sadece tek hesap + tek post için manuel aksiyon olarak tutar.

## Özellikler

- Cloudflare Worker tek dosya backend + HTML dashboard
- Cloudflare D1 ile hesaplar, OAuth state, planlı postlar, audit log
- OAuth 2.0 Authorization Code + PKCE
- Access/refresh token şifreleme: AES-GCM, WebCrypto
- Admin login ve imzalı session cookie
- Yetkili hesap ekleme/silme
- Özgün içerik şartıyla çoklu hesap yayın kampanyası
- Zamanlanmış postlar için Cron Trigger
- Tek hesapta manuel beğeni / repost / quote-post denemesi
- Audit log

## Kurulum

1. D1 oluştur:

```bash
npx wrangler d1 create x_manager_db
```

Çıkan `database_id` değerini `wrangler.toml` içindeki `database_id` alanına yaz.

2. Migration uygula:

```bash
npx wrangler d1 migrations apply x_manager_db --remote
```

3. Secret değerleri gir:

```bash
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SESSION_SECRET
npx wrangler secret put TOKEN_ENCRYPTION_KEY
npx wrangler secret put X_CLIENT_ID
npx wrangler secret put X_CLIENT_SECRET
```

`X_CLIENT_SECRET` zorunlu değildir; X Developer Console'da Web App/Automated App gibi confidential client kullanıyorsan girmen önerilir. `SESSION_SECRET` ve `TOKEN_ENCRYPTION_KEY` en az 32 karakter rastgele değerler olmalı.

4. X Developer Console ayarları:

- App Authentication: OAuth 2.0 etkin
- App type: Web App veya Automated App / bot
- Callback URL: `https://YOUR_WORKER_DOMAIN/oauth/x/callback`
- Website URL: Worker domainin
- Scopes: `tweet.read tweet.write users.read offline.access like.write`

5. Deploy:

```bash
npx wrangler deploy
```

6. Panel:

Worker URL'ni aç, `ADMIN_PASSWORD` ile giriş yap, "X hesabı bağla" butonuyla hesapları tek tek yetkilendir.

## Güvenlik notları

- `wrangler.toml` içine secret koyma.
- X tokenleri D1 içinde AES-GCM ile şifrelenir.
- Admin panelini Cloudflare Access arkasına almak tavsiye edilir.
- Üretimde `BASE_URL` env değişkeni kullanarak callback URL'inin sabit kalmasını sağlayabilirsin.
- X API planın quote-post için Enterprise gerektirebilir; self-serve planda quote isteği X tarafından reddedilebilir.

## Sınırlar

- Aynı içerik birden fazla hesapta aynı anda gönderilemez; uygulama bunu reddeder.
- Beğeni/repost bulk yapılmaz. Manuel tek hesap aksiyonu olarak uygulanır.
- Keşfet/trend/hashtag manipülasyonu için otomasyon içermez.
