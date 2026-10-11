# ============================================================
# security.sh —— 随机密钥与随机串生成
# 本文件由 deploy/install.sh 拆分而来，只放函数定义，不要直接执行。
# ============================================================
rand() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

rand_short() { head -c 9 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
