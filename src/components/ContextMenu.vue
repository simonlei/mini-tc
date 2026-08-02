<template>
  <!-- Full-screen overlay: any click / right-click / mousedown outside the
       menu closes it. The menu itself stops propagation so clicks on items
       select rather than close. -->
  <div
    v-if="visible"
    class="ctx-overlay"
    @mousedown="emit('close')"
    @click="emit('close')"
    @contextmenu.prevent="emit('close')"
  >
    <div
      class="ctx-menu"
      :style="menuStyle"
      @mousedown.stop
      @click.stop
      @contextmenu.prevent.stop
    >
      <template v-for="(item, i) in items" :key="i">
        <div v-if="item.separator" class="ctx-sep"></div>
        <div
          v-else
          class="ctx-item"
          :class="{ disabled: item.disabled }"
          @click="!item.disabled && emit('select', item)"
        >{{ item.label }}</div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { computed } from "vue";

const props = defineProps({
  visible: { type: Boolean, default: false },
  // Viewport coordinates (clientX / clientY) where the menu should open.
  x: { type: Number, default: 0 },
  y: { type: Number, default: 0 },
  items: { type: Array, default: () => [] },
});

const emit = defineEmits(["close", "select"]);

// Rough dimensions used to keep the menu inside the viewport.
const EST_ITEM_H = 28;
const EST_WIDTH = 260;

const menuStyle = computed(() => {
  const estH = props.items.length * EST_ITEM_H + 8;
  let top = props.y;
  let left = props.x;
  if (top + estH > window.innerHeight) {
    top = Math.max(8, window.innerHeight - estH);
  }
  if (left + EST_WIDTH > window.innerWidth) {
    left = Math.max(8, window.innerWidth - EST_WIDTH);
  }
  return { left: left + "px", top: top + "px" };
});
</script>

<style scoped>
.ctx-overlay {
  position: fixed;
  inset: 0;
  z-index: 500;
}

.ctx-menu {
  position: fixed;
  min-width: 220px;
  max-width: 320px;
  background: var(--panel-bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
  padding: 4px 0;
  user-select: none;
}

.ctx-item {
  display: flex;
  align-items: center;
  min-height: 26px;
  padding: 3px 14px;
  font-size: 12px;
  color: var(--text);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ctx-item:hover {
  background: var(--accent);
  color: #fff;
}

.ctx-item.disabled {
  color: var(--text-dim);
  cursor: default;
}

.ctx-item.disabled:hover {
  background: transparent;
  color: var(--text-dim);
}

.ctx-sep {
  height: 1px;
  margin: 4px 8px;
  background: var(--border);
}
</style>
