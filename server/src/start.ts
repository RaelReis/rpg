/**
 * Ponto de entrada de producao.
 *
 * `IS_PROD` decide se o servidor entrega o build do cliente e como o CORS se
 * comporta, e depende de NODE_ENV. Rodar `npm start` sem definir a variavel —
 * o caminho mais natural — subia o servidor em modo de desenvolvimento, sem
 * servir o cliente: a implantacao parecia funcionar e o navegador recebia 404.
 *
 * Definir aqui, antes de qualquer import que leia a configuracao, evita
 * depender de o operador lembrar (e de `cross-env`, que so existiria por
 * causa do `set` do Windows). O `??=` preserva um NODE_ENV ja definido pelo
 * ambiente, para quem quiser subir em outro modo de proposito.
 */
export {};

process.env.NODE_ENV ??= 'production';

await import('./index.js');
