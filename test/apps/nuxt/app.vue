<template><div>{{ msg }}</div></template>
<script setup>
import { camelCase } from 'lodash-es';
const msg = camelCase('hello nuxt');
</script>
