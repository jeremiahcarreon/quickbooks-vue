import 'primeicons/primeicons.css';
import './styles.css';
import { createApp } from 'vue';
import App from './App.vue';
import { installPlugins } from './plugins';
import { createAppRouter } from './router';

const app = createApp(App);
const router = createAppRouter();
installPlugins(app, router);
app.mount('#app');
