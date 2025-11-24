const PX_PER_SEC = 30;
function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

const state = {
  clips: [],
  images: [],
  texts: [],
  audios: [],
  audioSources: [],
  totalDuration: 0,
  currentTime: 0,
  isPlaying: false,
  activeClipIndex: -1,
  selection: { type: null, index: -1, dragging: false, offsetX: 0, offsetY: 0 },
  timelineHoverX: null,
  // 导出配置
  export: { start: 0, end: 0 },
};

const DOM = {
  editor: document.getElementById("editorCanvas"),
  ctx: document.getElementById("editorCanvas").getContext("2d"),
  timelineWrapper: document.getElementById("timelineWrapper"),
  timeline: document.getElementById("timelineCanvas"),
  tCtx: document.getElementById("timelineCanvas").getContext("2d"),
  video: document.getElementById("sourceVideo"),
  uploader: document.getElementById("videoUploader"),
  clipList: document.getElementById("clipListContainer"),
  playBtn: document.getElementById("playBtn"),
  exportBtn: document.getElementById("exportBtn"),
  status: document.getElementById("status"),
  placeholder: document.getElementById("placeholder"),

  imgUploader: document.getElementById("imgUploader"),
  imgPanel: document.getElementById("imgControlPanel"),
  imgScale: document.getElementById("imgScale"),
  imgOpacity: document.getElementById("imgOpacity"),
  imgStart: document.getElementById("imgStart"),
  imgEnd: document.getElementById("imgEnd"),
  delImgBtn: document.getElementById("delImgBtn"),

  txtPanel: document.getElementById("textControlPanel"),
  addTxtBtn: document.getElementById("addTxtBtn"),
  delTxtBtn: document.getElementById("delTxtBtn"),
  txtContent: document.getElementById("txtContent"),
  txtSize: document.getElementById("txtSize"),
  txtColor: document.getElementById("txtColor"),
  txtStart: document.getElementById("txtStart"),
  txtEnd: document.getElementById("txtEnd"),

  audioUploader: document.getElementById("audioFileUploader"),
  audioPanel: document.getElementById("audioControlPanel"),
  audioStart: document.getElementById("audioStart"),
  audioVol: document.getElementById("audioVol"),
  delAudioBtn: document.getElementById("delAudioBtn"),

  // 导出控件
  expStart: document.getElementById("expStart"),
  expEnd: document.getElementById("expEnd"),
};

const AudioContext = window.AudioContext || window.webkitAudioContext;
const audioCtx = new AudioContext();
const audioDest = audioCtx.createMediaStreamDestination();

// 【新增】创建一个 GainNode (音量控制) 专门用于视频原声
const videoGain = audioCtx.createGain();
videoGain.gain.value = 1.0; // 原声音量 1.0

// 【新增】连接路径：
// 视频原声 -> videoGain -> audioDest (用于录制)
// videoGain -> audioCtx.destination (用于让用户听到)
// 注意：createMediaElementSource 只能调用一次，所以放在全局初始化里
let videoSourceNode = null;
try {
  videoSourceNode = audioCtx.createMediaElementSource(DOM.video);
  videoSourceNode.connect(videoGain);
  videoGain.connect(audioDest);
  videoGain.connect(audioCtx.destination);
} catch (e) {
  console.warn("MediaElementSource 创建失败 (可能是跨域问题或已存在):", e);
}

let animationId;

// === 1. 视频加载 ===
DOM.uploader.addEventListener("change", async (e) => {
  const files = Array.from(e.target.files);
  if (files.length === 0) return;
  DOM.status.textContent = `正在分析 ${files.length} 个视频...`;
  for (let file of files) {
    const duration = await getVideoDuration(file);
    state.clips.push({
      id: Date.now() + Math.random(),
      file: file,
      url: URL.createObjectURL(file),
      duration: duration,
      name: file.name,
    });
  }
  updateTimelineStructure();
  renderClipCards();
  if (state.clips.length > 0 && !state.isPlaying) loadClipToVideo(0, 0);
  DOM.placeholder.style.display = "none";
  DOM.playBtn.disabled = false;
  DOM.exportBtn.disabled = false;
  DOM.status.textContent = "准备就绪";
});

function getVideoDuration(file) {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () => resolve(v.duration);
    v.src = URL.createObjectURL(file);
  });
}

function updateTimelineStructure() {
  let cursor = 0;
  state.clips.forEach((clip) => {
    clip.globalStart = cursor;
    clip.globalEnd = cursor + clip.duration;
    cursor += clip.duration;
  });
  state.totalDuration = cursor;

  // 默认导出范围为全长
  state.export.end = state.totalDuration;
  DOM.expEnd.value = state.totalDuration.toFixed(1);

  updateTimelineDimensions();
}

// === 导出范围监听 ===
DOM.expStart.addEventListener("change", (e) => {
  state.export.start = parseFloat(e.target.value);
  drawTimeline(); // 重绘阴影
});
DOM.expEnd.addEventListener("change", (e) => {
  state.export.end = parseFloat(e.target.value);
  drawTimeline();
});

// === 2. 多图片管理 ===
DOM.imgUploader.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const img = new Image();
  img.src = URL.createObjectURL(file);
  img.onload = () => {
    state.images.push({
      id: Date.now(),
      imgObj: img,
      x: DOM.editor.width / 2,
      y: DOM.editor.height / 2,
      baseW: img.width,
      baseH: img.height,
      scale: 0.5,
      opacity: 1,
      start: state.currentTime,
      end: Math.min(state.totalDuration, state.currentTime + 3),
    });
    selectObject("image", state.images.length - 1);
    drawFrame();
    e.target.value = "";
  };
});
DOM.delImgBtn.addEventListener("click", () => {
  if (state.selection.type === "image") {
    state.images.splice(state.selection.index, 1);
    selectObject(null);
  }
});
["scale", "opacity", "start", "end"].forEach((key) => {
  DOM["img" + key.charAt(0).toUpperCase() + key.slice(1)].addEventListener(
    "input",
    (e) => {
      if (state.selection.type === "image") {
        state.images[state.selection.index][key] = parseFloat(e.target.value);
        drawFrame();
      }
    }
  );
});

// === 3. 多文字管理 ===
DOM.addTxtBtn.addEventListener("click", () => {
  const newTxt = {
    id: Date.now(),
    content: "输入文字...",
    x: DOM.editor.width / 2 || 400,
    y: DOM.editor.height / 2 || 300,
    size: 50,
    color: "#ffffff",
    start: state.currentTime,
    end: Math.min(state.totalDuration, state.currentTime + 3),
  };
  state.texts.push(newTxt);
  selectObject("text", state.texts.length - 1);
});
DOM.delTxtBtn.addEventListener("click", () => {
  if (state.selection.type === "text") {
    state.texts.splice(state.selection.index, 1);
    selectObject(null);
  }
});
const bindTxtInput = (id, key, isNum = false) => {
  DOM[id].addEventListener("input", (e) => {
    if (state.selection.type === "text") {
      state.texts[state.selection.index][key] = isNum
        ? parseFloat(e.target.value)
        : e.target.value;
      drawFrame();
    }
  });
};
bindTxtInput("txtContent", "content");
bindTxtInput("txtSize", "size", true);
bindTxtInput("txtColor", "color");
bindTxtInput("txtStart", "start", true);
bindTxtInput("txtEnd", "end", true);

// === 4. 音频上传与管理 (新增) ===
DOM.audioUploader.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  DOM.status.textContent = "正在解码音频...";
  const arrayBuffer = await file.arrayBuffer();
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

  state.audios.push({
    id: Date.now(),
    buffer: audioBuffer,
    start: state.currentTime, // 默认插在当前时间
    duration: audioBuffer.duration,
    volume: 1.0,
    name: file.name,
  });

  selectObject("audio", state.audios.length - 1);
  drawFrame(); // 重绘时间轴
  DOM.status.textContent = "音频添加成功";
  e.target.value = "";
});

DOM.delAudioBtn.addEventListener("click", () => {
  if (state.selection.type === "audio") {
    state.audios.splice(state.selection.index, 1);
    selectObject(null);
    stopAudio(); // 停止可能正在播放的声音
  }
});

// 绑定音频输入
DOM.audioStart.addEventListener("change", (e) => {
  if (state.selection.type === "audio") {
    state.audios[state.selection.index].start = parseFloat(e.target.value);
    drawTimeline();
    if (!state.isPlaying) stopAudio(); // 调整时间时停止播放
  }
});
DOM.audioVol.addEventListener("input", (e) => {
  if (state.selection.type === "audio") {
    state.audios[state.selection.index].volume = parseFloat(e.target.value);
    // 实时调整音量比较复杂，这里简化为下次播放生效
  }
});

// === 5. 音频播放核心逻辑 (新增) ===
function playAudio() {
  // 先清理旧的源
  stopAudio();

  if (audioCtx.state === "suspended") audioCtx.resume();

  state.audios.forEach((track) => {
    // 计算偏移量
    // 1. 如果当前播放头在音频开始之前：需要等待 (track.start - state.currentTime) 秒后播放
    // 2. 如果当前播放头在音频中间：需要立即播放，但从 (state.currentTime - track.start) 秒开始播

    const renderTime = state.currentTime; // 视频编辑器的当前时间

    // 情况 A: 还没播到这段音频，但即将播到 (在导出范围内)
    if (track.start >= renderTime) {
      const when = audioCtx.currentTime + (track.start - renderTime);
      createSource(track, when, 0);
    }
    // 情况 B: 正在这段音频中间
    else if (
      track.start < renderTime &&
      track.start + track.duration > renderTime
    ) {
      const offset = renderTime - track.start;
      const when = audioCtx.currentTime; // 立即播放
      createSource(track, when, offset);
    }
  });
}

function createSource(track, when, offset) {
  const source = audioCtx.createBufferSource();
  source.buffer = track.buffer;

  const gainNode = audioCtx.createGain();
  gainNode.gain.value = track.volume;

  source.connect(gainNode);

  // 连接到扬声器用于预览
  gainNode.connect(audioCtx.destination);
  // 连接到导出流用于录制
  gainNode.connect(audioDest);

  // 计算持续时间：总长 - 偏移量
  const duration = track.duration - offset;

  source.start(when, offset, duration);
  state.audioSources.push(source);
}

function stopAudio() {
  state.audioSources.forEach((s) => {
    try {
      s.stop();
    } catch (e) {}
  });
  state.audioSources = [];
}

// === 4. 播放与渲染 ===
function syncVideoSource(globalTime) {
  const idx = state.clips.findIndex(
    (c) => globalTime >= c.globalStart && globalTime < c.globalEnd
  );
  const target = idx === -1 ? state.clips.length - 1 : idx;
  if (target < 0) return;
  const clip = state.clips[target];
  const local = Math.max(
    0,
    Math.min(globalTime - clip.globalStart, clip.duration)
  );
  if (state.activeClipIndex !== target) {
    DOM.video.src = clip.url;
    state.activeClipIndex = target;
  }
  if (Math.abs(DOM.video.currentTime - local) > 0.3)
    DOM.video.currentTime = local;
}

function loadClipToVideo(index, localTime) {
  if (index >= state.clips.length) return;
  DOM.video.src = state.clips[index].url;
  DOM.video.currentTime = localTime;
  state.activeClipIndex = index;
  DOM.video.onloadedmetadata = () => {
    DOM.editor.width = DOM.video.videoWidth;
    DOM.editor.height = DOM.video.videoHeight;
    drawFrame();
  };
}

function drawFrame() {
  const W = DOM.editor.width;
  const H = DOM.editor.height;
  DOM.ctx.clearRect(0, 0, W, H);
  if (state.clips.length > 0) DOM.ctx.drawImage(DOM.video, 0, 0, W, H);

  state.images.forEach((img, idx) => {
    const inTime =
      state.currentTime >= img.start && state.currentTime <= img.end;
    const isSel =
      state.selection.type === "image" && state.selection.index === idx;
    if (inTime || (isSel && !state.isPlaying)) {
      DOM.ctx.save();
      DOM.ctx.globalAlpha = inTime ? img.opacity : 0.3;
      const dw = img.baseW * img.scale,
        dh = img.baseH * img.scale;
      const dx = img.x - dw / 2,
        dy = img.y - dh / 2;
      DOM.ctx.drawImage(img.imgObj, dx, dy, dw, dh);
      if (isSel) {
        DOM.ctx.strokeStyle = "var(--secondary)";
        DOM.ctx.lineWidth = 3;
        DOM.ctx.strokeRect(dx, dy, dw, dh);
      }
      DOM.ctx.restore();
    }
  });

  state.texts.forEach((txt, idx) => {
    const inTime =
      state.currentTime >= txt.start && state.currentTime <= txt.end;
    const isSel =
      state.selection.type === "text" && state.selection.index === idx;
    if (inTime || (isSel && !state.isPlaying)) {
      DOM.ctx.save();
      DOM.ctx.globalAlpha = inTime ? 1.0 : 0.4;
      DOM.ctx.font = `bold ${txt.size}px Arial`;
      DOM.ctx.fillStyle = txt.color;
      DOM.ctx.textAlign = "center";
      DOM.ctx.textBaseline = "middle";
      DOM.ctx.strokeStyle = "black";
      DOM.ctx.lineWidth = 4;
      DOM.ctx.strokeText(txt.content, txt.x, txt.y);
      DOM.ctx.fillText(txt.content, txt.x, txt.y);
      if (isSel) {
        DOM.ctx.strokeStyle = "var(--tertiary)";
        DOM.ctx.lineWidth = 2;
        DOM.ctx.setLineDash([5, 5]);
        const m = DOM.ctx.measureText(txt.content);
        DOM.ctx.strokeRect(
          txt.x - m.width / 2 - 10,
          txt.y - txt.size / 2 - 5,
          m.width + 20,
          txt.size + 10
        );
      }
      DOM.ctx.restore();
    }
  });
  drawTimeline();
}

function updateLoop() {
  if (!state.isPlaying) return;
  const clip = state.clips[state.activeClipIndex];
  if (clip) {
    state.currentTime = clip.globalStart + DOM.video.currentTime;
    if (DOM.video.currentTime >= clip.duration) {
      if (state.activeClipIndex + 1 < state.clips.length) {
        syncVideoSource(state.clips[state.activeClipIndex + 1].globalStart);
        DOM.video.play();
      } else {
        state.isPlaying = false;
        DOM.playBtn.textContent = "播放";
        return;
      }
    }
  }
  const headX = state.currentTime * PX_PER_SEC;
  if (
    headX >
    DOM.timelineWrapper.scrollLeft + DOM.timelineWrapper.clientWidth - 20
  ) {
    DOM.timelineWrapper.scrollLeft = headX - 100;
  }
  drawFrame();
  animationId = requestAnimationFrame(updateLoop);
}

// === 5. 交互逻辑 ===
function updateSelectionUI() {
  DOM.txtPanel.classList.remove("active-control");
  DOM.imgPanel.classList.remove("active-control");
  DOM.audioPanel.classList.remove("active-control");
  if (state.selection.type === "text") {
    DOM.txtPanel.classList.add("active-control");
    const t = state.texts[state.selection.index];
    if (t) {
      DOM.txtContent.value = t.content;
      DOM.txtSize.value = t.size;
      DOM.txtColor.value = t.color;
      DOM.txtStart.value = t.start;
      DOM.txtEnd.value = t.end;
    }
  } else if (state.selection.type === "image") {
    DOM.imgPanel.classList.add("active-control");
    const i = state.images[state.selection.index];
    if (i) {
      DOM.imgScale.value = i.scale;
      DOM.imgOpacity.value = i.opacity;
      DOM.imgStart.value = i.start;
      DOM.imgEnd.value = i.end;
    }
  } else if (state.selection.type === "audio") {
    DOM.audioPanel.classList.add("active-control");
    const a = state.audios[state.selection.index];
    if (a) {
      DOM.audioStart.value = a.start;
      DOM.audioVol.value = a.volume;
    }
  }
}

function selectObject(type, index) {
  state.selection.type = type;
  state.selection.index = index;
  updateSelectionUI();
  drawFrame();
}

DOM.editor.addEventListener("mousedown", (e) => {
  const rect = DOM.editor.getBoundingClientRect();
  const sx = DOM.editor.width / rect.width,
    sy = DOM.editor.height / rect.height;
  const mx = (e.clientX - rect.left) * sx,
    my = (e.clientY - rect.top) * sy;
  for (let i = state.texts.length - 1; i >= 0; i--) {
    const t = state.texts[i];
    if (Math.sqrt((mx - t.x) ** 2 + (my - t.y) ** 2) < t.size) {
      selectObject("text", i);
      state.selection.dragging = true;
      state.selection.offsetX = mx - t.x;
      state.selection.offsetY = my - t.y;
      return;
    }
  }
  for (let i = state.images.length - 1; i >= 0; i--) {
    const img = state.images[i];
    const w = img.baseW * img.scale,
      h = img.baseH * img.scale;
    if (
      mx >= img.x - w / 2 &&
      mx <= img.x + w / 2 &&
      my >= img.y - h / 2 &&
      my <= img.y + h / 2
    ) {
      selectObject("image", i);
      state.selection.dragging = true;
      state.selection.offsetX = mx - img.x;
      state.selection.offsetY = my - img.y;
      return;
    }
  }
  selectObject(null, -1);
});
window.addEventListener("mousemove", (e) => {
  if (!state.selection.dragging) return;
  const rect = DOM.editor.getBoundingClientRect();
  const sx = DOM.editor.width / rect.width,
    sy = DOM.editor.height / rect.height;
  const mx = (e.clientX - rect.left) * sx,
    my = (e.clientY - rect.top) * sy;
  if (state.selection.type === "text") {
    const t = state.texts[state.selection.index];
    t.x = mx - state.selection.offsetX;
    t.y = my - state.selection.offsetY;
  } else if (state.selection.type === "image") {
    const i = state.images[state.selection.index];
    i.x = mx - state.selection.offsetX;
    i.y = my - state.selection.offsetY;
  }
  if (!state.isPlaying) drawFrame();
});
window.addEventListener("mouseup", () => (state.selection.dragging = false));

// === 6. 时间轴绘制 (带导出阴影) ===
function updateTimelineDimensions() {
  const minW = DOM.timelineWrapper.clientWidth;
  const contentW = state.totalDuration * PX_PER_SEC;
  DOM.timeline.width = Math.max(minW, contentW + 200);
  DOM.timeline.height = DOM.timelineWrapper.clientHeight;
  drawTimeline();
}
window.addEventListener("resize", updateTimelineDimensions);

function drawTimeline() {
  const ctx = DOM.tCtx,
    w = DOM.timeline.width,
    h = DOM.timeline.height;
  ctx.clearRect(0, 0, w, h);

  // 刻度
  ctx.fillStyle = "#94a3b8";
  const major = PX_PER_SEC;
  for (let i = 0; i < Math.ceil(w / major); i++) {
    const x = i * major;
    ctx.fillRect(x, h - 12, 1, 12);
    ctx.fillRect(x + major / 2, h - 6, 1, 6);
    ctx.fillText(formatTime(i), x + 3, h - 14);
  }

  // 视频轨道 (底层)
  state.clips.forEach((c, i) => {
    ctx.fillStyle = i % 2 ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.05)";
    ctx.fillRect(
      c.globalStart * PX_PER_SEC,
      0,
      c.duration * PX_PER_SEC,
      h - 15
    );
  });

  // 音频轨道 (黄色)
  state.audios.forEach((au, i) => {
    const sx = au.start * PX_PER_SEC;
    const wid = au.duration * PX_PER_SEC;
    // 选中高亮
    ctx.fillStyle =
      state.selection.type === "audio" && state.selection.index === i
        ? "#facc15"
        : "rgba(234, 179, 8, 0.5)";
    ctx.fillRect(sx, 60, wid, 10); // y=70
    ctx.fillStyle = "#000";
    ctx.font = "10px Arial";
    ctx.fillText("♪ " + au.name, sx + 2, 66, wid - 4);
  });

  // 图片轨道 (中间)
  state.images.forEach((img, i) => {
    const sx = img.start * PX_PER_SEC,
      wid = (img.end - img.start) * PX_PER_SEC;
    ctx.fillStyle =
      state.selection.type === "image" && state.selection.index === i
        ? "#34d399"
        : "rgba(16, 185, 129, 0.5)";
    ctx.fillRect(sx, 40 + (i % 3) * 6, wid, 6);
  });

  // 文字轨道 (上层)
  state.texts.forEach((txt, i) => {
    const sx = txt.start * PX_PER_SEC,
      wid = (txt.end - txt.start) * PX_PER_SEC;
    ctx.fillStyle =
      state.selection.type === "text" && state.selection.index === i
        ? "#f472b6"
        : "rgba(244, 63, 94, 0.5)";
    ctx.fillRect(sx, 10 + (i % 3) * 8, wid, 8);
  });

  // --- 绘制导出范围遮罩 (新增) ---
  const expStartX = state.export.start * PX_PER_SEC;
  const expEndX = state.export.end * PX_PER_SEC;

  // 左侧阴影
  ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
  ctx.fillRect(0, 0, expStartX, h);
  // 右侧阴影
  ctx.fillRect(expEndX, 0, w - expEndX, h);

  // 导出范围标记线
  ctx.strokeStyle = "var(--quaternary)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(expStartX, 0);
  ctx.lineTo(expStartX, h);
  ctx.moveTo(expEndX, 0);
  ctx.lineTo(expEndX, h);
  ctx.stroke();

  // 播放头
  const headX = state.currentTime * PX_PER_SEC;
  ctx.strokeStyle = "#ef4444";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(headX, 0);
  ctx.lineTo(headX, h);
  ctx.stroke();
  ctx.fillStyle = "#ef4444";
  ctx.beginPath();
  ctx.moveTo(headX - 6, 0);
  ctx.lineTo(headX + 6, 0);
  ctx.lineTo(headX, 8);
  ctx.fill();

  // === 8. [新增] 鼠标悬浮时间提示 ===
  if (state.timelineHoverX !== null) {
    const x = state.timelineHoverX;
    const time = x / PX_PER_SEC;
    // 绘制白色虚线
    ctx.save();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
    ctx.restore();
    // 绘制时间文字框
    const text = formatTime(time);
    const padding = 6;
    const textWidth = ctx.measureText(text).width;
    const boxWidth = textWidth + padding * 2;
    const boxHeight = 20;
    // 智能定位：防止提示框超出右边界
    let boxX = x + 10;
    if (boxX + boxWidth > w) {
      boxX = x - boxWidth - 10;
    }
    // 背景
    ctx.fillStyle = "#334155";
    ctx.fillRect(boxX, 5, boxWidth, boxHeight);
    
    // 文字
    ctx.fillStyle = "#fff";
    ctx.textBaseline = "middle";
    ctx.fillText(text, boxX + padding, 5 + boxHeight / 2);
  }
}

DOM.timeline.addEventListener("mousedown", (e) => {
  const clickX = e.offsetX;
  const clickY = e.offsetY;
  const t = clickX / PX_PER_SEC;

  // 检查点击Y轴区域，判断是否点中音频轨道 (y=70, height=10)
  if (clickY >= 70 && clickY <= 80) {
    // 检查是否在某个音频的时间范围内
    let hitAudioIndex = -1;
    for (let i = 0; i < state.audios.length; i++) {
      const au = state.audios[i];
      if (t >= au.start && t <= au.start + au.duration) {
        hitAudioIndex = i;
        break; // 找到即停
      }
    }

    if (hitAudioIndex !== -1) {
      selectObject("audio", hitAudioIndex);
      // 阻止时间跳转（可选，如果想让点击音频只是选中而不跳转时间）
      e.stopPropagation();
      return;
    }
  }

  // 如果没点中音频，执行原有的时间跳转逻辑
  state.currentTime = Math.max(0, Math.min(state.totalDuration, t));
  if (state.isPlaying) togglePlay();
  syncVideoSource(state.currentTime);
  // 如果跳转时间，我们也要重新触发 playAudio (为了准确预览，先停止再播放会比较卡，这里简单的 seek 逻辑可以暂不处理音频 seek，等松开鼠标再播)
  stopAudio();
  drawFrame();

  // 拖动逻辑...
  const onMove = (ev) => {
    const nt = ev.offsetX / PX_PER_SEC;
    state.currentTime = Math.max(0, Math.min(state.totalDuration, nt));
    syncVideoSource(state.currentTime);
    drawFrame();
  };
  const onUp = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
});

// === 7. 播放与导出 (范围版) ===
DOM.playBtn.addEventListener("click", togglePlay);
function togglePlay() {
  if (state.isPlaying) {
    // 暂停
    state.isPlaying = false;
    DOM.video.pause();
    stopAudio(); // 停止音频
    DOM.playBtn.textContent = "播放";
    cancelAnimationFrame(animationId);
  } else {
    // 播放
    state.isPlaying = true;
    DOM.video.play();
    playAudio(); // 开始音频
    DOM.playBtn.textContent = "暂停";
    updateLoop();
  }
}

// DOM.exportBtn.addEventListener("click", () => {
//   if (state.isPlaying) togglePlay();

//   const start = state.export.start;
//   const end = state.export.end;
//   if (start >= end) {
//     alert("结束时间必须大于开始时间");
//     return;
//   }

//   DOM.status.textContent = `正在录制 ${start}s 到 ${end}s...`;
//   state.currentTime = start;
//   syncVideoSource(start);

//   const originalMuted = DOM.video.muted;
//   DOM.video.muted = false;

//   if (audioCtx.state === "suspended") audioCtx.resume();

//   // 等待 seek 完成
//   setTimeout(() => {
//     // 1. 获取视频画面流 (从 Canvas)
//     const canvasStream = DOM.editor.captureStream(30);
//     const videoTrack = canvasStream.getVideoTracks()[0];

//     // 2. 获取混合音频流 (从 Web Audio API 的 destination)
//     // 此时 audioDest 里已经包含了：视频原声(videoSourceNode) + 背景音乐
//     const mixedAudioStream = audioDest.stream;
//     const audioTrack = mixedAudioStream.getAudioTracks()[0];

//     // 3. 组合最终流
//     const finalStream = new MediaStream();
//     if (videoTrack) finalStream.addTrack(videoTrack);
//     if (audioTrack) finalStream.addTrack(audioTrack);

//     // 如果没有音频轨道，提示一下
//     if (!audioTrack) console.warn("警告：未检测到音频输出");

//     // 4. 开始录制
//     // 尝试使用更兼容的编码配置
//     let options = { mimeType: "video/webm;codecs=vp9,opus" };
//     if (!MediaRecorder.isTypeSupported(options.mimeType)) {
//       options = { mimeType: "video/webm" };
//     }

//     const recorder = new MediaRecorder(finalStream, options);
//     const chunks = [];

//     recorder.ondataavailable = (e) => {
//       if (e.data && e.data.size > 0) chunks.push(e.data);
//     };

//     recorder.onstop = () => {
//       const blob = new Blob(chunks, { type: "video/webm" });
//       const url = URL.createObjectURL(blob);
//       const a = document.createElement("a");
//       a.href = url;
//       a.download = `export_${start}_to_${end}.webm`;
//       a.click();

//       DOM.status.textContent = "导出完成";
//       DOM.video.muted = originalMuted; // 恢复状态
//     };

//     recorder.start();

//     // 5. 开始播放 (这一步驱动画面动，同时驱动声音通过 Web Audio 播放)
//     state.isPlaying = true;
//     DOM.video.play(); // 视频开始播 -> videoSourceNode 有数据 -> audioDest
//     playAudio(); // 音乐开始播 -> audioDest

//     function exportLoop() {
//       if (!state.isPlaying) {
//         recorder.stop();
//         stopAudio();
//         return;
//       }
//       updateLoop(); // 驱动 Canvas 画面更新

//       if (state.currentTime >= end) {
//         state.isPlaying = false;
//         recorder.stop();
//         stopAudio();
//         DOM.playBtn.textContent = "播放";
//       } else {
//         requestAnimationFrame(exportLoop);
//       }
//     }

//     cancelAnimationFrame(animationId);
//     exportLoop();
//   }, 500); // 等待 500ms 确保 seek 完成且流已就绪
// });

// === 修改后的导出逻辑 (支持 MP4) ===
DOM.exportBtn.addEventListener('click', () => {
    if(state.isPlaying) togglePlay();
    
    const start = state.export.start;
    const end = state.export.end;
    if(start >= end) { alert("结束时间必须大于开始时间"); return; }

    DOM.status.textContent = `准备录制...`;
    state.currentTime = start; 

    // --- 定义录制核心函数 ---
    const startRecordingProcess = () => {
        DOM.video.removeEventListener('seeked', onVideoSeeked);
        DOM.status.textContent = `正在录制 ${start}s 到 ${end}s...`;

        // 1. 画面流
        const canvasStream = DOM.editor.captureStream(30);
        const videoTrack = canvasStream.getVideoTracks()[0];

        // 2. 音频流准备
        const originalMuted = DOM.video.muted;
        DOM.video.muted = false;
        if (audioCtx.state === 'suspended') audioCtx.resume();

        const mixedAudioStream = audioDest.stream;
        const audioTrack = mixedAudioStream.getAudioTracks()[0];

        // 3. 组合流
        const finalStream = new MediaStream();
        if (videoTrack) finalStream.addTrack(videoTrack);
        if (audioTrack) finalStream.addTrack(audioTrack);

        // 4. 【关键修改】智能选择格式 (优先 MP4)
        const detectMimeType = () => {
            const types = [
                'video/mp4;codecs=avc1,mp4a.40.2', // 最标准的 MP4 (H.264 + AAC)
                'video/mp4',                        // 通用 MP4
                'video/webm;codecs=vp9,opus',       // 高质量 WebM
                'video/webm;codecs=vp8,opus',       // 兼容 WebM
                'video/webm'                        // 通用 WebM
            ];
            for (let t of types) {
                if (MediaRecorder.isTypeSupported(t)) return t;
            }
            return 'video/webm'; // 最后的保底
        };

        const selectedMimeType = detectMimeType();
        console.log(`导出格式: ${selectedMimeType}`);
        
        // 根据 MIME 类型决定文件后缀
        const fileExtension = selectedMimeType.includes('mp4') ? 'mp4' : 'webm';

        const recorder = new MediaRecorder(finalStream, { 
            mimeType: selectedMimeType,
            videoBitsPerSecond: 5000000 // 提高比特率以提升 MP4 清晰度 (5Mbps)
        });
        
        const chunks = [];
        recorder.ondataavailable = e => { if(e.data && e.data.size > 0) chunks.push(e.data); };
        recorder.onstop = () => {
            const blob = new Blob(chunks, {type: selectedMimeType});
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); 
            a.href = url; 
            a.download = `export_${start}_${end}.${fileExtension}`; // 动态后缀
            a.click();
            
            DOM.status.textContent = `导出完成 (${fileExtension})`;
            DOM.video.muted = originalMuted;
        };

        recorder.start();

        // 5. 播放驱动录制
        state.isPlaying = true;
        DOM.video.play();
        playAudio(); 

        function exportLoop() {
            if(!state.isPlaying) { recorder.stop(); stopAudio(); return; }
            updateLoop();
            if(state.currentTime >= end) { 
                state.isPlaying = false; recorder.stop(); stopAudio(); DOM.playBtn.textContent="播放"; 
            } else {
                requestAnimationFrame(exportLoop);
            }
        }
        cancelAnimationFrame(animationId);
        exportLoop();
    };

    // --- 事件驱动 Seek ---
    const onVideoSeeked = () => {
        requestAnimationFrame(() => {
             drawFrame();
             startRecordingProcess();
        });
    };

    DOM.video.addEventListener('seeked', onVideoSeeked, { once: true });
    syncVideoSource(start);

    // 兜底
    setTimeout(() => {
        if (DOM.status.textContent === `准备录制...`) {
            console.warn("Seek 超时，强制开始");
            onVideoSeeked();
        }
    }, 2000);
});

function renderClipCards() {
  DOM.clipList.innerHTML = "";
  state.clips.forEach((clip, i) => {
    const div = document.createElement("div");
    div.className = "clip-card";
    div.draggable = true;
    div.innerHTML = `<span class="clip-idx">${
      i + 1
    }</span><div class="clip-name">${
      clip.name
    }</div><div class="clip-dur">${clip.duration.toFixed(
      1
    )}s</div><div class="clip-remove" onclick="removeClip(${i})">×</div>`;
    div.ondragstart = () => div.classList.add("dragging");
    div.ondragend = () => div.classList.remove("dragging");
    div.ondrop = (e) => {
      e.preventDefault();
      const from =
        document.querySelector(".dragging").querySelector(".clip-idx")
          .innerText - 1;
      const item = state.clips.splice(from, 1)[0];
      state.clips.splice(i, 0, item);
      updateTimelineStructure();
      renderClipCards();
      syncVideoSource(state.currentTime);
      drawFrame();
    };
    div.ondragover = (e) => e.preventDefault();
    div.onclick = () => {
      state.currentTime = clip.globalStart;
      syncVideoSource(state.currentTime);
      drawFrame();
      DOM.timelineWrapper.scrollLeft = clip.globalStart * PX_PER_SEC;
    };
    DOM.clipList.appendChild(div);
  });
}
window.removeClip = (i) => {
  event.stopPropagation();
  state.clips.splice(i, 1);
  updateTimelineStructure();
  renderClipCards();
};

// === 鼠标悬浮监听 ===
DOM.timeline.addEventListener("mousemove", (e) => {
  // 记录鼠标在 Canvas 上的 X 坐标 (包含滚动偏移)
  state.timelineHoverX = e.offsetX;
  
  // 仅重绘时间轴，不重绘整个画面，性能更好
  drawTimeline();
});

DOM.timeline.addEventListener("mouseleave", () => {
  // 鼠标移出时清除状态
  state.timelineHoverX = null;
  drawTimeline();
});
