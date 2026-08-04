<template>
  <div class="preview-placeholder">
    <div class="preview-placeholder-title">暂不支持预览该格式</div>
    <div class="preview-placeholder-name" v-if="fileName">{{ fileName }}</div>
    <button
      v-if="!isDir"
      class="preview-as-text-btn"
      @click="$emit('preview-as-text')"
      title="以纯文本方式打开此文件，并将其后缀加入文本预览列表"
    >按文本预览</button>
  </div>
</template>

<script setup>
defineProps({
  fileName: { type: String, default: "" },
  // Directories can't be previewed as text, so the button is hidden for them.
  isDir: { type: Boolean, default: false },
});

defineEmits(["preview-as-text"]);
</script>

<style scoped>
.preview-placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: var(--panel-bg);
  color: var(--text-dim);
  user-select: none;
  text-align: center;
  padding: 16px;
}

.preview-placeholder-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}

.preview-placeholder-name {
  font-size: 12px;
  color: var(--text-dim);
  max-width: 90%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview-as-text-btn {
  margin-top: 4px;
  padding: 6px 18px;
  border: 1px solid var(--accent);
  border-radius: 4px;
  background: transparent;
  color: var(--accent);
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.preview-as-text-btn:hover {
  background: var(--accent);
  color: #fff;
}
</style>
