# Gemma 4 遷移手冊（實驗室電腦部署）

最後更新：2026-07-13。程式端改造已完成（`llm_adapter.py` + Chat Completions agent loop），
筆電（OpenAI）與實驗室電腦（Ollama + Gemma 4）**只差 config 設定**，不需改任何程式碼。

## 架構總覽

| 元件 | 筆電（開發） | 實驗室電腦 | 原因 |
|---|---|---|---|
| Agent 主模型 | gpt-5.4-mini | **Gemma 4 31B（Ollama）** | 成本主戰場 |
| 輔助模型（分類/改寫/rerank） | gpt-4o-mini | **Gemma 4 31B（Ollama）** | 同上 |
| Embedding | OpenAI text-embedding-3-small | OpenAI（**不換**） | $0.02/百萬 tokens，換了省不到錢 |
| 多模態（Whisper/TTS/圖片） | OpenAI | OpenAI（**不換**） | 使用者已確認 |
| 評估評分員 | gpt-4o-mini | gpt-4o-mini（**永遠固定**） | 量尺不可變，否則跨配置分數不可比 |

所以實驗室電腦**仍需要 OPENAI_API_KEY**（只用於 embedding／多模態／評分，費用極低）。

## 實驗室電腦設定步驟（Ubuntu + RTX 5090 32GB）

### 1. 裝 Ollama 並拉模型

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull gemma4:31b          # Q4 量化版約 18-20GB，下載需一段時間
```

### 2. 設定 context 長度（重要，預設太小）

本系統的 system prompt＋工具定義＋歷史＋工具回傳輕鬆超過 8K tokens，
必須把 context 拉到 16K 以上：

```bash
# 方法一：建立自訂 Modelfile
cat > Modelfile << 'EOF'
FROM gemma4:31b
PARAMETER num_ctx 16384
EOF
ollama create gemma4-16k -f Modelfile
# 之後 config 填 gemma4-16k

# 方法二（全域）：環境變數
export OLLAMA_CONTEXT_LENGTH=16384
```

注意：16K context 的 KV cache 會多吃 2-4GB VRAM，32GB 卡跑 Q4 31B 剛好夠；
若 OOM，退到 num_ctx 12288 或換更小量化版。

### 3. 驗證 Ollama 正常

```bash
ollama list                                        # 應看到模型
curl http://localhost:11434/v1/models             # OpenAI 相容端點有回應
curl http://localhost:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gemma4-16k","messages":[{"role":"user","content":"你好"}]}'
```

### 4. 改 config.txt（只改這裡）

在 `NTPUOPE_v2/config.txt` 加入／修改：

```
LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL_BIG=gemma4-16k
OLLAMA_MODEL_SMALL=gemma4-16k
OPENAI_API_KEY=sk-...        ← 保留！embedding/多模態/評分仍需要
```

（切回 OpenAI：把 `LLM_PROVIDER` 改回 `openai` 即可；未設定時預設就是 openai。）

### 5. 啟動與驗證

```bash
# 建環境（Linux 上用 uv 或 pip 裝 requirements.txt 的服務端子集）
uv venv --python 3.12 .venv
uv pip install --python .venv langchain==0.3.20 langchain-community==0.3.19 \
  langchain-core==0.3.44 langchain-openai==0.3.8 langchain-text-splitters==0.3.6 \
  "openai==1.66.3" faiss-cpu==1.10.0 deep-translator==1.11.4 rank-bm25==0.2.2 \
  requests numpy pillow fastapi uvicorn apscheduler openpyxl

.venv/bin/python -m uvicorn main:app --port 8000
# 啟動 log 應出現：[LLM adapter] provider=ollama, big=gemma4-16k, ...
# 首次啟動會建 FAISS 索引（~90 秒），之後吃快取 2 秒
```

冒煙測試三題（與筆電對照）：

```bash
curl -s -X POST http://localhost:8000/api/chat -H "Content-Type: application/json" \
  -d '{"question":"114學年度全大運，邱薇聿在哪個項目獲得第一名？"}'
# 預期：一般女生組跆拳道對打62公斤級 第1名
# 另測：「如何辦理通識課程加退選？」（ge）、「多益成績可以抵免大學英文嗎？」（lc）
```

### 6. 正式驗收：跑 100 題評估

```bash
.venv/bin/python -X utf8 -u evaluate/run_baseline.py gemma4_r1
.venv/bin/python -X utf8 -u evaluate/run_baseline.py gemma4_r2   # 跑兩輪取平均
```

對照基準（OpenAI 配置、同一套題、同一評分員）：
- `baseline_medium_r1/r2`：Responses API 時代，strict 平均 **60.5%**
- `baseline_chatapi_medium_r1/r2`：目前 Chat Completions loop（遷移前最終基準）

判讀重點：
- **工具命中率**最可能掉分（開源模型 function calling 較弱）——若 tool_accuracy 明顯下滑，
  先檢查逐題的 `called_tools`，考慮簡化工具描述或減少工具數
- 單輪雜訊約 ±4-5 題，小於此差距不算訊號
- 延遲：本地推理每輪 LLM 呼叫會比 API 慢，看計時 log 的 `llm第N輪`

## 程式端已完成的改造（2026-07-13）

- `llm_adapter.py`：供應商切換層。`complete()` 供輔助任務、`chat_events()` 供 agent loop，
  自動處理 `reasoning_effort`／`max_completion_tokens` 等供應商差異參數（不支援就剝除重試）
- Agent loop 改 Chat Completions + tools：**4 輪上限、最後一輪強制作答**（tool_choice="none"），
  工具參數 JSON 解析寬容化、空 tool_call id 自動補號（開源模型常見問題）
- Ollama 模式自動降級為非逐字串流（前端仍有工具狀態提示與完整答案）；OpenAI 模式串流不變
- 評分員固定 gpt-4o-mini（`run_baseline.py` 內獨立 client，不受 LLM_PROVIDER 影響）

## VRAM 調校（吃緊時依序嘗試，前三項不用改程式）

本專案 Python 端不碰 GPU（faiss-cpu），VRAM 全由 Ollama 使用。
32GB 跑 Q4 31B＋16K ctx 預期夠用；若 OOM 或 `ollama ps` 顯示逼近上限：

1. **KV cache 優化**（幾乎無品質損失）：
   ```bash
   export OLLAMA_FLASH_ATTENTION=1
   export OLLAMA_KV_CACHE_TYPE=q8_0
   ```
2. **降 num_ctx**：16384 → 12288（注意長對話與多輪工具結果可能爆 context）
3. **更激進量化**：Q3／IQ 系列，換完務必重跑 100 題評估驗證品質
4. **縮程式端 prompt 預算**（最後手段，需評估數據佐證）：
   歷史輪數 8→4、news 內文摘要 800→500 字、檢索 top_k 6→4。
   位置：`agentic_v2_5_4high.py` 的 `recent_history`、`tool_get_latest_news`、`tool_search_database`。

## 給實驗室電腦上的 Claude Code

本手冊是自包含的部署依據。建議的開場指示：
「請先讀 NTPUOPE_v2/GEMMA_MIGRATION.md，照步驟部署：裝 Ollama、拉模型、建環境、
改 config.txt 切 ollama 模式、跑三題冒煙測試。」
評估結果（baseline_gemma4_r*.json）的對比分析建議帶回原開發環境進行，
對照基準與判讀脈絡（雜訊帶 ±4-5 題、失敗題聚類、混合配置判準）記錄於原環境。

## 已知風險與備案

1. **Gemma 4 tool calling 穩定度**：v1 時代 gemma3 的 tool accuracy 評估紀錄可當心理預期
   （`evaluate/results/Agentic_RAG_gemma3_tool_accuracy*.csv`）。掉太多的備案：
   混合配置——agent 主模型留 API、輔助任務全 Gemma（仍省下大部分費用）
2. **併發**：Ollama 單請求排隊，多人同時測試會等；屆時考慮 vLLM
3. **語音/圖片在 Ollama 模式仍走 OpenAI**：斷網環境這些功能不可用
