<template>
  <div class="ai-trainer-chat">
    <div class="ai-trainer-header">
      <span class="ai-trainer-title">🤖 AI Trainer</span>
      <button class="ai-trainer-close-btn" @click="$emit('close')" title="Close AI Trainer">✕</button>
    </div>

    <div class="ai-trainer-messages" ref="messageList">
      <div
        v-for="(msg, idx) in messages"
        :key="idx"
        :class="['ai-trainer-message', 'ai-trainer-message--' + msg.role]"
      >
        <div class="ai-trainer-message-text">{{ msg.text }}</div>
      </div>
      <div v-if="isLoading" class="ai-trainer-message ai-trainer-message--trainer">
        <div class="ai-trainer-message-text ai-trainer-loading">Thinking…</div>
      </div>
    </div>

    <div v-if="latestRecommendation" class="ai-trainer-recommend-row">
      <button class="btn btn-primary ai-trainer-play-btn" @click="playRecommendation" :disabled="isLoading">
        Play Recommendation
      </button>
    </div>

    <div class="ai-trainer-input-row">
      <textarea
        class="ai-trainer-input"
        v-model="userInput"
        placeholder="Ask a question…"
        rows="2"
        @keydown.enter.exact.prevent="sendQuestion"
      ></textarea>
      <button class="btn ai-trainer-send-btn" @click="sendQuestion" :disabled="isLoading || !userInput.trim()">
        Ask
      </button>
    </div>
  </div>
</template>

<script lang="ts">
import {defineComponent} from 'vue';

interface ChatMessage {
  role: 'trainer' | 'user';
  text: string;
  recommendation?: Record<string, unknown>;
}

export default defineComponent({
  name: 'AiTrainerChat',
  props: {
    gameId: {type: String, required: true},
    playerId: {type: String, required: true},
    waitingForKey: {type: String, required: true},
  },
  emits: ['action-played', 'close'],
  data() {
    return {
      messages: [] as ChatMessage[],
      userInput: '',
      isLoading: false,
      latestRecommendation: null as Record<string, unknown> | null,
      lastFetchedKey: '' as string,
    };
  },
  watch: {
    waitingForKey(newKey: string) {
      if (newKey && newKey !== this.lastFetchedKey) {
        this.fetchAdvice();
      }
    },
  },
  mounted() {
    if (this.waitingForKey) {
      this.fetchAdvice();
    }
  },
  methods: {
    async fetchAdvice(userQuestion?: string) {
      this.isLoading = true;
      this.lastFetchedKey = this.waitingForKey;
      try {
        const body: Record<string, unknown> = {
          game_id: this.gameId,
          player_id: this.playerId,
        };
        if (userQuestion) {
          body['user_question'] = userQuestion;
        }
        const resp = await fetch('/api/ai/advice', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(body),
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({error: resp.statusText}));
          this.messages.push({role: 'trainer', text: `Error: ${err.error ?? resp.statusText}`});
          return;
        }
        const data = await resp.json();
        this.messages.push({
          role: 'trainer',
          text: data.advice_text || '(no advice text)',
          recommendation: data.recommendation,
        });
        this.latestRecommendation = data.recommendation ?? null;
        this.$nextTick(() => this.scrollToBottom());
      } catch (e) {
        this.messages.push({role: 'trainer', text: `Network error: ${e}`});
      } finally {
        this.isLoading = false;
      }
    },
    async sendQuestion() {
      const q = this.userInput.trim();
      if (!q || this.isLoading) return;
      this.messages.push({role: 'user', text: q});
      this.userInput = '';
      this.$nextTick(() => this.scrollToBottom());
      await this.fetchAdvice(q);
    },
    async playRecommendation() {
      if (!this.latestRecommendation || this.isLoading) return;
      this.isLoading = true;
      try {
        const resp = await fetch('/api/ai/play-recommendation', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            game_id: this.gameId,
            player_id: this.playerId,
            input_response: this.latestRecommendation,
          }),
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({error: resp.statusText}));
          this.messages.push({role: 'trainer', text: `Play error: ${err.error ?? resp.statusText}`});
          return;
        }
        this.latestRecommendation = null;
        this.$emit('action-played');
        // Reload so the next waitingFor / phase / state renders identically to the
        // normal Play button path (no risk of a stale poll cycle).
        window.location.reload();
      } catch (e) {
        this.messages.push({role: 'trainer', text: `Network error: ${e}`});
      } finally {
        this.isLoading = false;
      }
    },
    scrollToBottom() {
      const el = this.$refs.messageList as HTMLElement | undefined;
      if (el) el.scrollTop = el.scrollHeight;
    },
  },
});
</script>
