# Feature: MVP Base de HouseMatch (Spec 0001)

## Descripción
Esta feature establece la estructura base inicial del MVP para el procesamiento de pedidos inmobiliarios recibidos desde WhatsApp y el cruzamiento con una cartera local.

## Objetivos
1. Escuchar grupos de WhatsApp en tiempo real usando Baileys.
2. Filtrar mensajes de forma rápida con expresiones regulares.
3. Extraer información estructurada (dormitorios, tipo, moneda, presupuesto) usando Gemini y OpenAI.
4. Clasificar ubicaciones geográficas y realizar un algoritmo de cruce físico.
5. Sincronizar carteras de propiedades usando Google Sheets API.
