import * as admin from "firebase-admin";
import {ImageAnnotatorClient} from "@google-cloud/vision";
import * as path from "path";
import * as os from "os";
import * as fs from "fs/promises";
import sharp from "sharp";
import {PDFDocument, rgb, StandardFonts} from "pdf-lib";

import {onObjectFinalized} from "firebase-functions/v2/storage";
import {setGlobalOptions} from "firebase-functions/v2";

setGlobalOptions({
  region: "europe-west3",
  maxInstances: 5,
});

admin.initializeApp();

const visionClient = new ImageAnnotatorClient();

export const processUploadedImage = onObjectFinalized(async (event) => {
  const object = event.data;

  const fileBucket = object?.bucket;
  const filePath = object?.name;
  const contentType = object?.contentType;
  // const metadata = object?.metadata || {}; // Entfernt, da nicht verwendet

  if (
    !fileBucket ||
    !filePath ||
    !contentType ||
    !contentType.startsWith("image/") ||
    !object.size
  ) {
    console.log("Keine Bilddatei oder Metadatenproblem, überspringe.");
    return null;
  }

  console.log(`Verarbeite Bild: ${filePath} (Typ: ${contentType})`);

  const pathParts = filePath.split("/");
  if (
    pathParts.length < 5 ||
    pathParts[0] !== "users" ||
    pathParts[2] !== "folders" ||
    pathParts[4] !== "raw_images"
  ) {
    console.error(
      "Ungültiger Dateipfad für Bildverarbeitung. Erwartet: " +
      "users/{userId}/folders/{folderId}/raw_images/{imageId}.jpg"
    );
    return null;
  }
  const userId = pathParts[1];
  const folderId = pathParts[3];
  const originalFileName = path.basename(filePath);

  console.log(`Verarbeite für User: ${userId}, Ordner: ${folderId}`);

  const bucket = admin.storage().bucket(fileBucket);
  const fileName = path.basename(filePath);
  const tempDirPath = os.tmpdir();
  const tempRawImagePath = path.join(tempDirPath, fileName);
  const tempProcessedImagePath = path.join(
    tempDirPath, `processed_${fileName}`
  );
  const tempPdfPath = path.join(
    tempDirPath, `${path.parse(fileName).name}.pdf`
  );

  // 1. Bild herunterladen
  try {
    await bucket.file(filePath).download({destination: tempRawImagePath});
    console.log(`Bild heruntergeladen nach ${tempRawImagePath}`);
  } catch (error) {
    console.error("Fehler beim Herunterladen des Bildes:", error);
    return null;
  }

  // 2. Bild verarbeiten (z.B. zuschneiden/verkleinern)
  // Hier ist ein einfacher Resize-Platzhalter.
  // Das automatische Erkennen und Zuschneiden von Formen ist komplex
  // und würde erweiterte Vision API Funktionen oder eine ML-Modellintegration
  // erfordern.
  try {
    await sharp(tempRawImagePath)
      .resize({width: 1000, withoutEnlargement: true})
      .jpeg({quality: 80})
      .toFile(tempProcessedImagePath);
    console.log(
      `Bild verarbeitet und gespeichert als ${tempProcessedImagePath}`
    ); // Hier umgebrochen
  } catch (error) {
    console.error("Fehler bei der Bildverarbeitung (sharp):", error);
    return null;
  }

  // 3. OCR mit Google Cloud Vision API durchführen
  let ocrText = "";
  try {
    const [result] = await visionClient.documentTextDetection(
      tempProcessedImagePath
    );
    const fullTextAnnotation = result.fullTextAnnotation;
    if (fullTextAnnotation?.text) {
      ocrText = fullTextAnnotation.text;
      console.log(
        "Erkannter Text (Auszug):\n",
        ocrText.substring(0, 200) + "..."
      );
    } else {
      console.log("Kein Text im Bild gefunden.");
    }
  } catch (error) {
    console.error("Fehler bei der OCR mit Vision API:", error);
    return null;
  }

  // 4. PDF generieren
  let pdfBytes: Uint8Array;
  try {
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

    const page = pdfDoc.addPage();
    const imageBytes = await fs.readFile(tempProcessedImagePath);
    let embeddedImage;
    if (contentType === "image/jpeg") {
      embeddedImage = await pdfDoc.embedJpg(imageBytes);
    } else if (contentType === "image/png") {
      embeddedImage = await pdfDoc.embedPng(imageBytes);
    } else {
      console.warn(
        `Unbekannter Bildtyp ${contentType}, versuche als PNG einzubetten.`
      );
      embeddedImage = await pdfDoc.embedPng(imageBytes);
    }

    const {width, height} = page.getSize();
    const imageDims = embeddedImage.scale(
      Math.min(width / embeddedImage.width, height / embeddedImage.height)
    );

    page.drawImage(embeddedImage, {
      x: (width - imageDims.width) / 2,
      y: (height - imageDims.height) / 2,
      width: imageDims.width,
      height: imageDims.height,
    });

    page.drawText(ocrText, {
      x: 50,
      y: height - 50,
      font,
      size: 0.1,
      color: rgb(0, 0, 0),
      opacity: 0,
      lineHeight: 12,
    });

    pdfBytes = await pdfDoc.save();
    await fs.writeFile(tempPdfPath, pdfBytes);
    console.log(`PDF generiert und gespeichert als ${tempPdfPath}`);
  } catch (error) {
    console.error("Fehler bei der PDF-Generierung:", error);
    return null;
  } finally {
    await fs.unlink(tempRawImagePath);
    await fs.unlink(tempProcessedImagePath);
    console.log("Temporäre Bilddateien gelöscht.");
  }

  // 5. Generiertes PDF in Cloud Storage hochladen
  const newPdfPath =
    `users/${userId}/folders/${folderId}/documents/` +
    `${path.parse(fileName).name}.pdf`;
  let publicUrl = "";
  try {
    await bucket.upload(tempPdfPath, {
      destination: newPdfPath,
      metadata: {
        contentType: "application/pdf",
        ocrText: ocrText.substring(0, 1000),
        originalFileName: originalFileName,
      },
    });
    console.log(`Generiertes PDF hochgeladen nach ${newPdfPath}`);
    publicUrl =
      `https://firebasestorage.googleapis.com/v0/b/${fileBucket}/o/` +
      `${encodeURIComponent(newPdfPath)}?alt=media`;
  } catch (error) {
    console.error("Fehler beim Hochladen des PDF:", error);
    return null;
  } finally {
    await fs.unlink(tempPdfPath);
    console.log("Temporäre PDF-Datei gelöscht.");
  }

  // 6. Metadaten in Firestore speichern
  try {
    await admin.firestore()
      .collection("users").doc(userId)
      .collection("folders").doc(folderId)
      .collection("documents")
      .add({
        name: path.parse(originalFileName).name,
        pdfPath: newPdfPath,
        pdfUrl: publicUrl,
        ocrText: ocrText,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        originalImageName: originalFileName,
      });
    console.log("Dokumentenmetadaten in Firestore gespeichert.");
  } catch (error) {
    console.error("Fehler beim Speichern der Metadaten in Firestore:", error);
    return null;
  }

  console.log("Alle Verarbeitungsschritte abgeschlossen.");

  return null;
});
