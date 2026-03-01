# WordPress Agent - Available Actions

Complete reference of all available actions organized by agent.

## Quick Reference

| Agent | Actions | Description |
|-------|---------|-------------|
| posts | 6 | Create, read, update, delete posts |
| pages | 6 | Manage WordPress pages |
| media | 7 | Upload and manage media files |
| taxonomy | 10 | Categories, tags, custom taxonomies |
| users | 7 | User management |
| comments | 8 | Comment moderation |
| settings | 5 | Site configuration |
| menus | 10 | Navigation menus |
| plugins | 7 | Plugin/theme management |
| search | 4 | Cross-content search |

---

## Posts Agent (`posts`)

Manage WordPress blog posts.

### `posts.list`
List all posts with filtering.
```
Parameters:
  page: int = 1              # Page number
  per_page: int = 10         # Posts per page (max 100)
  search: str                # Search query
  status: str                # publish, draft, pending, private
  categories: list[int]      # Category IDs
  tags: list[int]            # Tag IDs
  author: int                # Author ID
  orderby: str = "date"      # Sort field
  order: str = "desc"        # Sort order
```

### `posts.get`
Get a single post by ID.
```
Parameters:
  post_id: int (required)    # Post ID
```

### `posts.create`
Create a new post.
```
Parameters:
  title: str (required)      # Post title
  content: str               # Post content (HTML)
  status: str = "draft"      # Post status
  excerpt: str               # Post excerpt
  categories: list[int]      # Category IDs
  tags: list[int]            # Tag IDs
  featured_media: int        # Featured image ID
  author: int                # Author ID
  format: str                # Post format
  sticky: bool               # Sticky post
  meta: dict                 # Custom meta fields
```

### `posts.update`
Update an existing post.
```
Parameters:
  post_id: int (required)    # Post ID
  title: str                 # Post title
  content: str               # Post content
  status: str                # Post status
  excerpt: str               # Post excerpt
  categories: list[int]      # Category IDs
  tags: list[int]            # Tag IDs
  featured_media: int        # Featured image ID
```

### `posts.delete`
Delete a post.
```
Parameters:
  post_id: int (required)    # Post ID
  force: bool = false        # Permanently delete (bypass trash)
```

### `posts.bulk-update-status`
Update status of multiple posts.
```
Parameters:
  post_ids: list[int] (required)  # List of post IDs
  status: str (required)          # New status
```

---

## Pages Agent (`pages`)

Manage WordPress pages.

### `pages.list`
List all pages.
```
Parameters:
  page: int = 1
  per_page: int = 10
  search: str
  status: str
  parent: int                # Parent page ID
  orderby: str = "menu_order"
  order: str = "asc"
```

### `pages.get`
Get a single page.
```
Parameters:
  page_id: int (required)
```

### `pages.create`
Create a new page.
```
Parameters:
  title: str (required)
  content: str
  status: str = "draft"
  parent: int                # Parent page ID
  menu_order: int = 0
  template: str              # Page template
  featured_media: int
  meta: dict
```

### `pages.update`
Update a page.
```
Parameters:
  page_id: int (required)
  title: str
  content: str
  status: str
  parent: int
  menu_order: int
  template: str
```

### `pages.delete`
Delete a page.
```
Parameters:
  page_id: int (required)
  force: bool = false
```

### `pages.get-hierarchy`
Get page hierarchy as tree structure.
```
Parameters: none
Returns: Nested tree of pages with parent-child relationships
```

---

## Media Agent (`media`)

Manage the WordPress media library.

### `media.list`
List media items.
```
Parameters:
  page: int = 1
  per_page: int = 10
  search: str
  media_type: str            # image, video, audio, application
  mime_type: str             # e.g., image/jpeg
```

### `media.get`
Get a media item.
```
Parameters:
  media_id: int (required)
```

### `media.upload`
Upload a file from local path.
```
Parameters:
  file_path: str (required)  # Local file path
  title: str
  caption: str
  alt_text: str
  description: str
```

### `media.upload-from-url`
Download and upload from URL.
```
Parameters:
  url: str (required)        # File URL
  title: str
  caption: str
  alt_text: str
```

### `media.update`
Update media metadata.
```
Parameters:
  media_id: int (required)
  title: str
  caption: str
  alt_text: str
  description: str
```

### `media.delete`
Delete a media item.
```
Parameters:
  media_id: int (required)
  force: bool = true
```

### `media.bulk-upload`
Upload all files from a directory.
```
Parameters:
  directory: str (required)  # Directory path
  pattern: str = "*"         # File pattern (e.g., *.jpg)
```

---

## Taxonomy Agent (`taxonomy`)

Manage categories, tags, and custom taxonomies.

### `taxonomy.list-categories`
List all categories.
```
Parameters:
  page: int = 1
  per_page: int = 100
  search: str
  parent: int
  hide_empty: bool = false
```

### `taxonomy.create-category`
Create a category.
```
Parameters:
  name: str (required)
  slug: str
  description: str
  parent: int
```

### `taxonomy.update-category`
Update a category.
```
Parameters:
  category_id: int (required)
  name: str
  slug: str
  description: str
  parent: int
```

### `taxonomy.delete-category`
Delete a category.
```
Parameters:
  category_id: int (required)
  force: bool = true
```

### `taxonomy.list-tags`
List all tags.
```
Parameters:
  page: int = 1
  per_page: int = 100
  search: str
  hide_empty: bool = false
```

### `taxonomy.create-tag`
Create a tag.
```
Parameters:
  name: str (required)
  slug: str
  description: str
```

### `taxonomy.update-tag`
Update a tag.
```
Parameters:
  tag_id: int (required)
  name: str
  slug: str
  description: str
```

### `taxonomy.delete-tag`
Delete a tag.
```
Parameters:
  tag_id: int (required)
  force: bool = true
```

### `taxonomy.list-taxonomies`
List all registered taxonomies.
```
Parameters: none
```

### `taxonomy.bulk-create-categories`
Create multiple categories.
```
Parameters:
  categories: list[dict] (required)
    - name: str (required)
    - slug: str
    - description: str
    - parent: int
```

### `taxonomy.bulk-create-tags`
Create multiple tags.
```
Parameters:
  tags: list[dict] (required)
    - name: str (required)
    - slug: str
    - description: str
```

---

## Users Agent (`users`)

Manage WordPress users.

### `users.list`
List all users.
```
Parameters:
  page: int = 1
  per_page: int = 10
  search: str
  roles: list[str]           # Filter by roles
  orderby: str = "name"
```

### `users.get`
Get a user by ID.
```
Parameters:
  user_id: int (required)
```

### `users.me`
Get current authenticated user.
```
Parameters: none
```

### `users.create`
Create a new user.
```
Parameters:
  username: str (required)
  email: str (required)
  password: str (required)
  name: str
  first_name: str
  last_name: str
  roles: list[str] = ["subscriber"]
  description: str
```

### `users.update`
Update a user.
```
Parameters:
  user_id: int (required)
  email: str
  name: str
  first_name: str
  last_name: str
  roles: list[str]
  description: str
  password: str
```

### `users.delete`
Delete a user.
```
Parameters:
  user_id: int (required)
  reassign: int              # Reassign content to user ID
  force: bool = true
```

### `users.list-roles`
List available user roles.
```
Parameters: none
```

---

## Comments Agent (`comments`)

Manage post comments.

### `comments.list`
List comments.
```
Parameters:
  page: int = 1
  per_page: int = 10
  search: str
  post: int                  # Filter by post ID
  status: str                # approved, hold, spam, trash
  author: int
  orderby: str = "date"
  order: str = "desc"
```

### `comments.get`
Get a comment.
```
Parameters:
  comment_id: int (required)
```

### `comments.create`
Create a comment.
```
Parameters:
  post: int (required)
  content: str (required)
  author_name: str
  author_email: str
  author_url: str
  parent: int                # Parent comment for replies
  status: str = "approved"
```

### `comments.update`
Update a comment.
```
Parameters:
  comment_id: int (required)
  content: str
  status: str
  author_name: str
  author_email: str
```

### `comments.delete`
Delete a comment.
```
Parameters:
  comment_id: int (required)
  force: bool = false
```

### `comments.approve`
Approve a pending comment.
```
Parameters:
  comment_id: int (required)
```

### `comments.spam`
Mark as spam.
```
Parameters:
  comment_id: int (required)
```

### `comments.bulk-moderate`
Moderate multiple comments.
```
Parameters:
  comment_ids: list[int] (required)
  action: str (required)     # approve, spam, trash, delete
```

---

## Settings Agent (`settings`)

Manage site settings (requires admin).

### `settings.get`
Get all site settings.
```
Parameters: none
```

### `settings.update`
Update site settings.
```
Parameters:
  title: str                 # Site title
  description: str           # Site tagline
  timezone_string: str
  date_format: str
  time_format: str
  start_of_week: int         # 0=Sunday, 1=Monday
  language: str
  posts_per_page: int
  default_category: int
  default_post_format: str
```

### `settings.get-site-info`
Get public site information.
```
Parameters: none
```

### `settings.get-post-types`
Get registered post types.
```
Parameters: none
```

### `settings.get-statuses`
Get available post statuses.
```
Parameters: none
```

---

## Menus Agent (`menus`)

Manage navigation menus.

### `menus.list`
List all menus.
```
Parameters: none
```

### `menus.get`
Get a menu.
```
Parameters:
  menu_id: int (required)
```

### `menus.create`
Create a menu.
```
Parameters:
  name: str (required)
  description: str
  locations: list[str]       # Theme locations
```

### `menus.update`
Update a menu.
```
Parameters:
  menu_id: int (required)
  name: str
  description: str
  locations: list[str]
```

### `menus.delete`
Delete a menu.
```
Parameters:
  menu_id: int (required)
  force: bool = true
```

### `menus.list-items`
List menu items.
```
Parameters:
  menus: int                 # Filter by menu ID
```

### `menus.add-item`
Add a menu item.
```
Parameters:
  menus: int (required)      # Menu ID
  title: str (required)
  url: str                   # Custom URL
  object_type: str           # post, page, category, custom
  object_id: int             # ID of linked object
  parent: int                # Parent menu item
  menu_order: int
  target: str                # _blank for new window
```

### `menus.update-item`
Update a menu item.
```
Parameters:
  item_id: int (required)
  title: str
  url: str
  parent: int
  menu_order: int
  target: str
```

### `menus.delete-item`
Delete a menu item.
```
Parameters:
  item_id: int (required)
  force: bool = true
```

### `menus.list-locations`
List theme menu locations.
```
Parameters: none
```

### `menus.assign-location`
Assign menu to location.
```
Parameters:
  location: str (required)
  menu_id: int (required)
```

---

## Plugins Agent (`plugins`)

Manage plugins and themes.

### `plugins.list`
List all plugins.
```
Parameters:
  status: str                # active, inactive
  search: str
```

### `plugins.get`
Get plugin details.
```
Parameters:
  plugin: str (required)     # Plugin slug (folder/file.php)
```

### `plugins.activate`
Activate a plugin.
```
Parameters:
  plugin: str (required)
```

### `plugins.deactivate`
Deactivate a plugin.
```
Parameters:
  plugin: str (required)
```

### `plugins.delete`
Delete a plugin.
```
Parameters:
  plugin: str (required)
```

### `plugins.list-themes`
List all themes.
```
Parameters:
  status: str
```

### `plugins.get-active-theme`
Get current theme.
```
Parameters: none
```

---

## Search Agent (`search`)

Search across content types.

### `search.search`
Search all content.
```
Parameters:
  query: str (required)
  page: int = 1
  per_page: int = 10
  type: str                  # post, page, category, etc.
  subtype: str
```

### `search.search-posts`
Search posts only.
```
Parameters:
  query: str (required)
  page: int = 1
  per_page: int = 10
```

### `search.search-pages`
Search pages only.
```
Parameters:
  query: str (required)
  page: int = 1
  per_page: int = 10
```

### `search.search-media`
Search media library.
```
Parameters:
  query: str (required)
  page: int = 1
  per_page: int = 10
```

---

## CLI Usage Examples

```bash
# List all posts
wp-agent exec posts.list

# Create a draft post
wp-agent exec posts.create title="My Post" content="<p>Hello</p>" status=draft

# Upload an image
wp-agent exec media.upload file_path="/path/to/image.jpg" alt_text="My image"

# Create categories in bulk
wp-agent exec taxonomy.bulk-create-categories categories='[{"name":"Cat1"},{"name":"Cat2"}]'

# Search site
wp-agent exec search.search query="charcuterie"

# Interactive mode
wp-agent -i
```

## API Usage Examples

```bash
# Start API server
python -m api.server

# Execute via HTTP
curl -X POST http://localhost:8000/execute \
  -H "Content-Type: application/json" \
  -d '{"agent":"posts","action":"list","params":{"per_page":5}}'

# Convenience endpoint
curl "http://localhost:8000/posts?per_page=5"
```
