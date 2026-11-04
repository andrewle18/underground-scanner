# Tham số bot — hiện trạng & lịch sử tinh chỉnh

Mọi tham số dưới đây chỉnh nóng được qua `/config?key=value` (lưu trong KV, ưu tiên
hơn giá trị mặc định trong code). Deploy lại **không** xoá cấu hình đã lưu.

## Bảng tham số

| Key | Mặc định | Ý nghĩa |
|---|---|---|
| `risk` | 2 | % rủi ro mỗi lệnh trên equity |
| `marginMax` | 100000 | trần ký quỹ mỗi lệnh (hiện đang set 10.000 qua config) |
| `tp1R` | 2.5 | khoảng cách TP1 theo R (1R = \|entry − SL\|) |
| `tp1Frac` | 0.4 | tỷ lệ chốt tại TP1 |
| `trailR` | 1.5 | khoảng cách trailing sau TP1, theo R |
| `earlyExit` | false | cắt lệnh khi gãy xu hướng lúc đang lỗ |
| `vgtHoiTu` | true | `vgt` chỉ vào lệnh khi có hội tụ đáy |
| `stockOn` | false | bật CK Mỹ |
| `feePct` | 0.05 | phí mỗi lượt vào/ra (% notional) |
| `sigoff` | — | tắt loại tín hiệu, vd `sigoff=vgt,buy` (vẫn ghi shadow log) |
| `pause` | false | ngừng mở lệnh mới |

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

## Lịch sử

### v4 — 25/10/2026 · sửa lỗi cấu trúc RR
Sau 8 lệnh chạy v3: −0,29R/lệnh, thắng 3/8. Cả hai lệnh TRAILING đều ăn đúng ~0,6R,
tức **nửa sau bị quét về đúng entry** — trailing 1R bằng đúng khoảng cách SL, giá hồi
1R là chuyện thường với crypto.

- `TP1_MAX_R` 1.2 → **2.5**
- `TP1_FRAC` 0.5 → **0.4**
- `TRAIL_R` mới → **1.5**

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
