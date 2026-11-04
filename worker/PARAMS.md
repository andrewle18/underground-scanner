# Tham số bot — hiện trạng & lịch sử tinh chỉnh

Mọi tham số dưới đây chỉnh nóng được qua `/config?key=value` (lưu trong KV, ưu tiên
hơn giá trị mặc định trong code). Deploy lại **không** xoá cấu hình đã lưu.

## Bảng tham số

| Key | Mặc định | Ý nghĩa |
|---|---|---|
| `risk` | 2 | % rủi ro mỗi lệnh trên equity |
| `marginPct` | — | **trần ký quỹ theo % equity** (đặt giá trị này sẽ xoá `marginMax`) |
| `marginMax` | 100000 | trần ký quỹ tuyệt đối — chỉ dùng khi chưa đặt `marginPct` |
| `tp1R` | 2.5 | khoảng cách TP1 theo R (1R = \|entry − SL\|) |
| `tp1Frac` | 0.4 | tỷ lệ chốt tại TP1 |
| `trailR` | 1.5 | khoảng cách trailing sau TP1, theo R |
| `earlyExit` | false | cắt lệnh khi gãy xu hướng lúc đang lỗ |
| `vgtHoiTu` | true | `vgt` chỉ vào lệnh khi có hội tụ đáy |
| `stockOn` | false | bật CK Mỹ |
| `feePct` | 0.05 | phí mỗi lượt vào/ra (% notional) |
| `sigoff` | — | tắt loại tín hiệu, vd `sigoff=vgt,buy` (vẫn ghi shadow log) |
| `pause` | false | ngừng mở lệnh mới |
| `tdEveryMin` | 30 | quét mã forex/CK **mới** mỗi N phút (mã đang có lệnh vẫn mỗi lượt) |

Ví dụ: `/config?tp1R=3&trailR=1.5&tp1Frac=0.4`

## Toán cấu trúc RR

Lãi điển hình khi nửa sau bị trailing quét = `tp1Frac × tp1R + (1−tp1Frac) × (tp1R − trailR)`.
Thua đủ = −1R. Win rate cần để hoà = `1 / (1 + lãi điển hình)`.

| Cấu hình | Lãi điển hình | Win rate cần |
|---|---|---|
| TP1 1.2R · chốt 50% · trail 1R (v3) | 0.70R | **59%** |
| TP1 2.5R · chốt 40% · trail 1.5R (v4) | 1.60R | **38%** |
| TP1 3.0R · chốt 40% · trail 1.5R | 2.10R | 32% |

Hệ trend-following thực tế thắng 30–40%, nên cấu hình phải nằm ở vùng dưới 40%.

## Trần ký quỹ quyết định risk thật, không phải `risk`

`risk=2` chỉ có hiệu lực khi trần ký quỹ đủ lớn. Ký quỹ cần thiết = `risk% × equity ÷ khoảng cách SL`.
SL crypto thường cách 7–15%, nên risk 2% đòi ký quỹ 13–29% equity. Trần thấp hơn thế
là riskPct bị cắt âm thầm.

| `marginPct` | Ký quỹ | Lỗ khi chạm SL (SL cách 10%) | 8 lệnh chiếm |
|---|---|---|---|
| (cũ: marginMax 10.000) | 10.000 | 1.027 = **0,10%** | 8% |
| 5 | 50.000 | 5.135 = 0,51% | 40% |
| 10 | 100.000 | 10.270 = 1,03% | 80% |
| 20 | 194.742 | 20.000 = **2,00%** | 160% ⚠ vượt vốn |

Tại 20% thì risk 2% mới thật sự hoạt động, nhưng `MAX_OPEN=8` lệnh sẽ không đủ vốn.
Muốn risk đúng 2% thì phải giảm `MAX_OPEN` xuống 4–5 trong code.

## Hạn mức Twelve Data

Gói free: 8 gọi/phút **và 800 gọi/ngày**. Mỗi mã tốn 2 gọi (H4 + H1).
Trước v5, mỗi lượt cron tiêu đúng 8 gọi → 96 × 8 = **768/ngày**, sát trần 800;
vài lần retry là hết credit và vàng/forex chết tới 0h UTC.

Hai van bảo vệ: `TD_BUDGET` (mỗi lượt) và `TD_DAILY_CAP=700` (mỗi ngày).
Mã đang có lệnh quét mỗi lượt; mã mới chỉ mỗi `tdEveryMin`. Khi còn <120 credit,
cả việc theo dõi lệnh mở cũng giãn theo nhịp đó thay vì để cạn hẳn giữa ngày.

| Lệnh forex mở | Gọi/ngày | Hoạt động tới |
|---|---|---|
| 0–2 | 384–576 | hết ngày |
| 3–4 | 630–680 | hết ngày |
| 5 | 700 | ~19.8h thì cạn |

Theo dõi qua `lastScan.tdCallsToday` trong `/status`.

## Lịch sử

### v4 — 25/10/2026 · sửa lỗi cấu trúc RR
Sau 8 lệnh chạy v3: −0,29R/lệnh, thắng 3/8. Cả hai lệnh TRAILING đều ăn đúng ~0,6R,
tức **nửa sau bị quét về đúng entry** — trailing 1R bằng đúng khoảng cách SL, giá hồi
1R là chuyện thường với crypto.

- `TP1_MAX_R` 1.2 → **2.5**
- `TP1_FRAC` 0.5 → **0.4**
- `TRAIL_R` mới → **1.5**

### v5 — 04/11/2026 · trần ký quỹ theo % equity, hạn mức TD, endpoint tra ký hiệu
- Thêm trần hạn mức Twelve Data theo ngày + giãn nhịp quét mã mới (xem mục trên).
- Thêm `marginPct`: trần ký quỹ tính theo % equity, co giãn theo tài khoản.
  `marginMax=10.000` cũ là số cứng khiến risk thật chỉ 0,1% thay vì 2%.
- Thêm `/sym?q=TON`: tra ký hiệu thật trên Bybit + OKX trước khi thêm coin.
  Dùng khi một mã báo "bybit rỗng | okx rỗng" — đó là ký hiệu sai, không phải sàn hỏng.
- Chuyển sang auto-deploy: push lên `main` là Cloudflare tự build (Root directory `worker`).

### v3 — 15/10/2026 · bỏ THOÁT SỚM, cap TP1
Phân tích 228 lệnh: nhánh THOÁT SỚM 115 lệnh thắng 1%, lỗ −33.264 — nhánh lỗ lớn nhất.
Long chỉ 16% chạm TP1 (short 40%) vì TP1 lấy từ Fibo extension, thường xa 5–20R.

- `EARLY_EXIT` → **false** (gãy xu hướng lúc lỗ: giữ lệnh, để SL tự quyết; lúc lãi: dời SL về hoà vốn)
- `TP1_MAX_R` mới → 1.2 *(sai, v4 sửa lại)*
- `VGT_NEED_HOITU` → **true** (vgt 66 lệnh thắng 15%; riêng yếu tố hội tụ đáy TB +104 vs −38)
- `STOCK_ON` → **false** (6 lệnh, −1.570, TSLA một mình −1.117 do gap)
- Viết lại `winScore`: đảo dấu sideway, BTC 20→5, hội tụ đáy 15→20. **Chỉ ghi log, không lọc lệnh.**

## Chỉ số theo dõi kỳ sau

Nhìn **R-multiple**, đừng nhìn PnL — PnL bị méo vì mỗi lệnh có R khác nhau.

- **R trung bình mỗi lệnh** — cần > 0
- **R trung bình của lệnh thắng** — cần ≥ 1.5 (v3 chỉ đạt 0.9)
- **Tỷ lệ long chạm TP1** — v3 trước sửa 16%, mục tiêu ~35–40% như short
- Đừng tăng `risk` cho tới khi R trung bình dương ổn định
