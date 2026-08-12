FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PORT=8080

WORKDIR /app

# 只裝執行時真正需要的套件；requirements.txt 內的 gradio、selenium、pandas 等
# 屬於爬蟲與評估工具，不在服務的執行路徑上。映像檔越小，容器冷啟動越快。
COPY requirements-runtime.txt .
RUN pip install --no-cache-dir -r requirements-runtime.txt

COPY . .

# 冷啟動說明：模組載入時會建立 FAISS 索引，5178 筆完整重建約 96 秒。
# 若建置環境帶有 .faiss_cache（由 CI 預先產生），啟動可縮短到約 4 秒。
CMD ["sh", "-c", "exec uvicorn agentic_v2_5_4high:app --host 0.0.0.0 --port ${PORT}"]
