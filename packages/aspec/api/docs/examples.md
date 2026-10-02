# Examples

```ts
const ast = parseFilterSort(new URLSearchParams('filter[status]=active&sort=-createdAt'), {
  status: { column: 'status', operators: ['eq'] },
  createdAt: { column: 'created_at', sortable: true },
});
const sql = toSql(ast, whitelist, 'postgres');
```
