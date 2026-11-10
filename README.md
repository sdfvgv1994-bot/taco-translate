# taco-translate（對譯）

taco 自己用的手機翻譯小工具，網頁版，放在 GitHub Pages。

網址：https://sdfvgv1994-bot.github.io/taco-translate/

## 第一版有什麼

- 打字翻譯：停下來不到一秒自動翻，10 種語言，可以一鍵對調。
- 語音輸入、朗讀譯文（用瀏覽器內建功能，Chrome 支援最好）。
- 「放大」：把譯文放到整個畫面給對方看。
- 紀錄與收藏：翻過的自動存，可以搜尋、收藏、刪除；沒網路時翻過的句子還看得到。

## 翻譯來源

- 沒填金鑰：用 MyMemory（免註冊，每天約 5,000 字元，比較不準，一次只能翻短句）。
- 在「設定」填 Azure Translator 金鑰和地區：改用 Azure（比較準，免費層每月 200 萬字元）。

金鑰只存在自己手機的瀏覽器（localStorage），不會進到這個 repo。

## 檔案

- `web/core.js`：規則（語言表、組請求、讀回應、紀錄的增刪改），不碰畫面。
- `web/app.js`：畫面與操作。
- `web/index.html`、`web/style.css`、`web/manifest.webmanifest`、`web/icon.svg`
- `tests/test_core.js`：規則測試，`node --test tests/test_core.js`。
- `.github/workflows/pages.yml`：測試通過才部署到 Pages。

## 之後

第二版：面對面對話。第三版：拍照翻譯。
