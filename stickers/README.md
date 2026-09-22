# Custom sticker packs

Create one folder per pack and add the real artwork supplied by the group. No placeholder artwork is bundled.

Example:

```text
stickers/
  weekend-chaos/
    pack.json
    laugh.webp
    lets-go.png
```

`pack.json`:

```json
{
  "id": "weekend-chaos",
  "name": "Weekend Chaos",
  "description": "Our custom reactions",
  "version": 1,
  "coverStickerId": "weekend-laugh",
  "stickers": [
    { "id": "weekend-laugh", "name": "Laugh", "file": "laugh.webp" },
    { "id": "weekend-go", "name": "Let's go", "file": "lets-go.png" }
  ]
}
```

Supported files are PNG, WebP, GIF, and SVG. Restart the API or use the admin **Reload sticker packs** action after adding files. IDs must remain stable because chat messages refer to them.
