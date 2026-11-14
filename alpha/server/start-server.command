#!/bin/zsh
# Bấm đúp trong Finder để bật server TranslatorOfDuck Alpha (không cần mở Terminal rồi cd).
cd "$(dirname "$0")" || exit 1
node server.mjs
echo
read -k1 "?Server đã dừng. Đọc dòng lỗi phía trên (nếu có), bấm phím bất kỳ để đóng."
