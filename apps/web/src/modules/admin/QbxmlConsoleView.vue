<script setup lang="ts">
/**
 * Raw qbXML console. The server validates every document against the Intuit
 * XSD before it is queued for QuickBooks; this page shows libxml2's errors
 * while typing (when the API offers a validate endpoint) and on send.
 */
import Button from 'primevue/button';
import Message from 'primevue/message';
import Select from 'primevue/select';
import Tag from 'primevue/tag';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { ApiError } from '@/api/client';
import { qbxmlApi, qbxmlIssues, type QbxmlIssue, type QbxmlResult } from '@/api/endpoints';
import XmlEditor from '@/components/XmlEditor.vue';
import XmlView from '@/components/XmlView.vue';
import { QBXML_TEMPLATES } from '@/lib/qbxmlTemplates';
import { checkWellFormed, prettyXml } from '@/lib/xml';
import { useCommandsStore } from '@/stores/commands';

const STORAGE_KEY = 'qbv.console.xml';
const commands = useCommandsStore();

function initial(): string {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) || QBXML_TEMPLATES[2]!.xml;
  } catch {
    return QBXML_TEMPLATES[2]!.xml;
  }
}

const xml = ref(initial());
const template = ref<string | null>(null);
const issues = ref<QbxmlIssue[]>([]);
/** null = not checked, true/false = server XSD verdict. */
const xsdValid = ref<boolean | null>(null);
const serverCheck = ref(true);
const wellFormed = ref<{ ok: boolean; message?: string; line?: number }>({ ok: true });
const checking = ref(false);
const sending = ref(false);
const result = ref<QbxmlResult | null>(null);
const sendError = ref<string | null>(null);

const errorLines = computed(() => [
  ...issues.value.map((i) => i.line).filter((l): l is number => l !== null),
  ...(wellFormed.value.line ? [wellFormed.value.line] : []),
]);

let timer: ReturnType<typeof setTimeout> | null = null;
let ctl: AbortController | null = null;

async function check() {
  wellFormed.value = checkWellFormed(xml.value);
  if (!wellFormed.value.ok) {
    xsdValid.value = false;
    issues.value = [];
    return;
  }
  if (!serverCheck.value) return;
  ctl?.abort();
  const my = new AbortController();
  ctl = my;
  checking.value = true;
  try {
    const res = await qbxmlApi.validate(xml.value, my.signal);
    if (ctl !== my) return;
    if (res === null) {
      // API has no validate endpoint: send still validates server-side
      serverCheck.value = false;
      xsdValid.value = null;
      return;
    }
    xsdValid.value = res.valid;
    issues.value = res.errors;
  } catch (err) {
    if ((err as Error).name !== 'AbortError') xsdValid.value = null;
  } finally {
    if (ctl === my) checking.value = false;
  }
}

watch(
  xml,
  (v) => {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, v);
    } catch {
      // ignore
    }
    xsdValid.value = null;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void check(), 500);
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer);
  ctl?.abort();
});

function useTemplate(name: string | null) {
  const t = QBXML_TEMPLATES.find((x) => x.name === name);
  if (t) xml.value = t.xml;
  template.value = null;
}

async function send() {
  wellFormed.value = checkWellFormed(xml.value);
  if (!wellFormed.value.ok) return;
  sending.value = true;
  sendError.value = null;
  result.value = null;
  try {
    const r = await qbxmlApi.send(xml.value);
    result.value = r;
    issues.value = [];
    xsdValid.value = true;
    if (r.commandId)
      commands.track({
        id: r.commandId,
        op: 'raw',
        label: 'qbXML console request',
        status: 'queued',
      });
  } catch (err) {
    if (err instanceof ApiError && err.status === 400) {
      issues.value = qbxmlIssues(err.details);
      xsdValid.value = false;
      sendError.value = err.message;
    } else {
      sendError.value = err instanceof Error ? err.message : String(err);
    }
  } finally {
    sending.value = false;
  }
}

const status = computed(() => {
  if (!wellFormed.value.ok) return { label: 'Not well-formed', severity: 'danger' };
  if (checking.value) return { label: 'Checking…', severity: 'secondary' };
  if (xsdValid.value === true) return { label: 'Valid against XSD', severity: 'success' };
  if (xsdValid.value === false) return { label: 'XSD errors', severity: 'danger' };
  return { label: serverCheck.value ? 'Not checked' : 'Validated on send', severity: 'secondary' };
});
</script>

<template>
  <div class="console">
    <div class="page-head">
      <h1>qbXML console</h1>
      <Tag :value="status.label" :severity="status.severity" data-testid="xsd-status" />
      <div class="page-head__spacer" />
      <Select
        v-model="template"
        :options="QBXML_TEMPLATES"
        option-label="name"
        option-value="name"
        placeholder="Templates"
        size="small"
        @update:model-value="useTemplate"
      />
      <Button
        label="Format"
        icon="pi pi-align-left"
        text
        size="small"
        @click="xml = prettyXml(xml)"
      />
      <Button
        label="Send"
        icon="pi pi-send"
        size="small"
        :loading="sending"
        :disabled="!wellFormed.ok"
        data-testid="send"
        @click="send"
      />
    </div>
    <p class="page-sub">
      Every request is validated against the qbXML schema on the server before it is queued for
      QuickBooks. Writes also update the read model. Ctrl+Enter sends.
    </p>
    <div class="console__grid">
      <div>
        <XmlEditor v-model="xml" :error-lines="errorLines" :rows="26" @submit="send" />
        <Message v-if="!wellFormed.ok" severity="error" :closable="false">{{
          wellFormed.message
        }}</Message>
        <Message v-if="sendError" severity="error" :closable="false" data-testid="send-error">{{
          sendError
        }}</Message>
        <ul v-if="issues.length" class="console__issues" data-testid="issues">
          <li v-for="(i, n) in issues" :key="n">
            <strong v-if="i.line !== null"
              >Line {{ i.line }}<template v-if="i.column">:{{ i.column }}</template></strong
            >
            {{ i.message }}
          </li>
        </ul>
      </div>
      <div>
        <h3>Response</h3>
        <p v-if="result?.status" class="page-sub">
          Command {{ result.commandId }} · {{ result.status }}
        </p>
        <XmlView v-if="result?.response" :xml="result.response" />
        <pre v-else-if="result" class="xml-view xml-code">{{
          JSON.stringify(result.body, null, 2)
        }}</pre>
        <p v-else class="page-sub">Send a request to see QuickBooks' answer.</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.console__grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 1rem;
}
@media (max-width: 1100px) {
  .console__grid {
    grid-template-columns: 1fr;
  }
}
.console__issues {
  margin: 0.5rem 0 0;
  padding-left: 1.1rem;
  color: var(--p-red-600);
  font-size: 0.85rem;
}
h3 {
  margin: 0 0 0.5rem;
  font-size: 0.9rem;
}
.console :deep(.p-message) {
  margin-top: 0.5rem;
}
</style>
