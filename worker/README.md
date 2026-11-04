# Andrew Le Scanner — Bot nền

Bot paper-trading chạy 24/7 trên Cloudflare Workers. Quét EMA 34/89 đa khung H4+H1
theo hệ thống Underground, tự mở/đóng lệnh trên tài khoản ảo, báo Telegram.

- **Worker:** `andrew-scanner-bot` · https://andrew-scanner-bot.lehunglinh18.workers.dev
- **Dashboard:** https://andrewle18.github.io/underground-scanner/
- **Dữ liệu:** Bybit/OKX/Binance (crypto) · Twelve Data (vàng/forex)
- **State:** Cloudflare KV, namespace `STATE`

## Cách deploy

Thư mục này nối với Cloudflare Workers Builds (nối ngày 04/11/2026).
**Push lên `main` là Cloudflare tự build và deploy**, khoảng 1 phút.
Không cần dán code vào dashboard nữa.

Cấu hình phía Cloudflare: Root directory `worker` · Deploy command `npx wrangler deploy`.

> **Cảnh báo:** `wrangler.toml` **ghi đè** cấu hình trên dashboard khi deploy.
> KV binding và cron phải luôn có mặt trong file đó. Xoá nhầm một trong hai thì
> bot mất sạch state (ví ảo + lịch sử lệnh) hoặc ngừng chạy nền.

## Cấu trúc

```
wrangler.toml     cấu hình deploy (name, KV binding, cron)
src/worker.js     toàn bộ logic bot
PARAMS.md         tham số hiện tại, lý do chọn, lịch sử tinh chỉnh
```

## Endpoint

| | |
|---|---|
| `/status` | tài khoản, lệnh đang mở, lịch sử (dashboard đọc cái này) |
| `/run` | quét ngay một lượt |
| `/config?...` | chỉnh tham số nóng, không cần deploy — xem PARAMS.md |
| `/check?sym=BTCUSDT` | soi tín hiệu một mã |
| `/close?id=...` | đóng tay một lệnh |
| `/deposit?amt=` · `/withdraw?amt=` | nạp/rút ví ảo |
| `/reset` | xoá sạch, về 1.000.000 |
| `/ping` | kiểm tra bot sống + bắn Telegram |
