# Litora - Digital Library

Litora is a modern, fast, and responsive digital library application built with vanilla HTML, CSS, and JavaScript. It provides a beautiful interface for users to browse, search, and read PDF books, while offering a comprehensive admin dashboard for managing the collection.

## Features

- **Modern UI/UX**: A sleek, dark-themed interface with glassmorphism effects, smooth animations, and responsive design for all devices.
- **User Authentication**: Secure signup and login powered by Supabase Auth.
- **PDF Reader**: Built-in PDF viewer using PDF.js for seamless reading without leaving the app.
- **Library Catalog**: Browse books, filter by multiple categories, and search by title or author.
- **Book Requests**: Users can request new books or specific editions, and admins can fulfill or reject them.
- **Admin Dashboard**:
  - Upload books and cover images (stored in Supabase and Cloudinary).
  - Manage multiple categories per book.
  - View user statistics and manage user roles.
  - Review and manage book requests.

## Tech Stack

- **Frontend**: HTML5, CSS3 (Vanilla), JavaScript (ES6+)
- **Backend & Database**: [Supabase](https://supabase.com/) (PostgreSQL, Auth, Storage, Edge Functions)
- **Image Hosting**: [Cloudinary](https://cloudinary.com/) (for optimized book covers)
- **PDF Rendering**: [PDF.js](https://mozilla.github.io/pdf.js/)
- **Icons**: FontAwesome

## Setup Instructions

1. **Clone the repository**
   ```bash
   git clone https://github.com/yourusername/litora.git
   cd litora
   ```

2. **Supabase Setup**
   - Create a new project in Supabase.
   - Run the provided database schema in your Supabase SQL editor to create the necessary tables, triggers, Row-Level Security (RLS) policies, and the `pdfs` storage bucket.
   - Note: The SQL schema file is not included in this repository for security purposes.

3. **Cloudinary Setup**
   - Create a free Cloudinary account.
   - Set up an **unsigned upload preset** for book covers.

4. **Configuration**
   - Open `js/config.js`.
   - Update the configuration object with your Supabase URL, Anon Key, and Cloudinary details:
     ```javascript
     window.APP_CONFIG = {
         appName: "Litora",
         supabase: {
             url: "YOUR_SUPABASE_URL",
             anonKey: "YOUR_SUPABASE_ANON_KEY"
         },
         cloudinary: {
             cloudName: "YOUR_CLOUDINARY_CLOUD_NAME",
             uploadPreset: "YOUR_UNSIGNED_PRESET"
         },
         storage: {
             pdfBucket: "pdfs",
             maxPdfSizeMB: 50,
             maxCoverSizeMB: 5
         }
     };
     ```

5. **Run Locally**
   - You can serve the files using any simple HTTP server. For example, using Python:
     ```bash
     python -m http.server 5500
     ```
   - Or using Node.js `serve` or VS Code Live Server.

## License

This project is licensed under the MIT License.
